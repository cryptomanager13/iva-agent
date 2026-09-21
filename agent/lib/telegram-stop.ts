// Остановка хода по кнопке ⏹ Стоп: общий текст исходов и обработчик нажатия для
// webhook-режима.
//
// Дверей две, и обе кончаются одним cancel-роутом канала:
//  - long-poll (штатный режим): нажатие ловит МОСТ (scripts/poller/control.ts) и зовёт
//    роут сам — так «Стоп» доходит даже до занятого агента;
//  - webhook-режим: моста нет вовсе, апдейт идёт прямо в eve, и нажатие ловит
//    onCallbackQuery канала — этот модуль.
// В long-poll мост съедает колбэк раньше (scripts/poller/main.ts зовёт handleControl
// до любой доставки), поэтому здешний путь там не срабатывает. Двойное срабатывание
// безопасно и так: cancel идемпотентен, `no_active_turn` — тоже успех.

import { requestTelegramCancel } from "./telegram-cancel-client.ts";
import { localCancelUrl } from "./telegram-cancel-route.ts";
import { allowedTelegramUsers } from "./telegram-allowlist.ts";
import { chatKeyOf, getChatStatus } from "./run-status.ts";
import { tr } from "./i18n.ts";
import { isPrivateTelegramChat } from "./telegram-private-chat.ts";
import { traceStop } from "./trace.ts";

// Исходы не смешиваются: «агент не отвечает» (роут молчит или отмену не подтвердил)
// и «отменять нечего» (нет sessionId или eve ответил no_active_turn) — разные факты
// с разным следующим шагом, а не два оттенка одного «не вышло».
export type StopOutcome = "requested" | "idle" | "unresponsive" | "failed";
export type StopStatus = Record<string, unknown> | null;
export type StopCancelResult = { readonly status?: unknown };
export type StopCancelRequest = {
  url: string;
  secret: string;
  sessionId: string;
  turnId?: string;
};
export type StopCallbackQuery = {
  readonly id: string;
  readonly data?: string;
  readonly from?: { readonly id?: number | string };
  readonly message?: {
    readonly chat: { readonly id: number | string; readonly type?: string };
    readonly messageThreadId?: number;
  };
};

// Функция, а не const: перевод выбирается в момент вызова (правило репо).
// `restarted` знает только мост: рестарт сервиса — его дело, канал про него молчит.
export function stopOutcomeText(
  outcome: StopOutcome,
  restarted = false,
): string {
  if (outcome === "requested") return tr("Stopping…", "Останавливаю…");
  if (outcome === "idle")
    return tr("Nothing is running right now.", "Сейчас ничего не выполняется.");
  if (outcome === "failed")
    return tr("Couldn't stop the turn.", "Не удалось остановить ход.");
  return restarted
    ? tr(
        "Iva wasn't responding — I restarted the service.",
        "Ива не отвечала — сервис перезапущен.",
      )
    : tr(
        "Iva isn't responding — I couldn't stop the turn.",
        "Ива не отвечает — остановить ход не удалось.",
      );
}

// Сколько ждём терминальное подтверждение отмены, прежде чем считать, что агент не
// отвечает. Ответ роута «принято» остановкой ещё не является: ход заканчивает
// turn.cancelled, и его видно по записи run-status. Подход тот же, что у ночного
// роллапа (scripts/lib/rollup-turn.ts): факт подтверждает терминальное событие, а не
// HTTP-ответ; разница только в источнике факта — там поток хода, здесь запись.
export const STOP_CONFIRM_TIMEOUT_MS = 10_000;
const STOP_CONFIRM_POLL_MS = 250;

// Ход жив, пока запись держит ЕГО sessionId в статусе running. Любое другое
// состояние — idle, чужая сессия, пропавшая запись — значит, отменять больше нечего.
function turnStillRunning(status: StopStatus, sessionId: string): boolean {
  return status?.status === "running" && status.sessionId === sessionId;
}

// Отменять можно ровно тогда, когда запись помнит непустой sessionId: свежесть
// записи для этого решения значения не имеет.
export function cancellableSessionId(status: StopStatus): string | null {
  const sessionId = status?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : null;
}

function hasCancelSecret(secret: string | undefined): secret is string {
  return secret !== undefined && secret.length > 0;
}

// Гард от запоздалого нажатия: несовпавший turnId eve глотает как no-op, но пустая
// строка ушла бы как значение — поле остаётся только при настоящем идентификаторе.
function cancelRequestBody({
  url,
  secret,
  sessionId,
  turnId,
}: {
  url: string;
  secret: string;
  sessionId: string;
  turnId: unknown;
}): StopCancelRequest {
  return {
    url,
    secret,
    sessionId,
    ...(typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}),
  };
}

async function waitForTurnStop(
  chatKey: string,
  sessionId: string,
  {
    getStatusImpl,
    timeoutMs,
    pollMs = STOP_CONFIRM_POLL_MS,
    now = Date.now,
    sleepImpl = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    getStatusImpl: (chatKey: string) => StopStatus;
    timeoutMs: number;
    pollMs?: number;
    now?: () => number;
    sleepImpl?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const deadline = now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!turnStillRunning(getStatusImpl(chatKey), sessionId)) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    // Спим не дольше дедлайна: иначе на коротком окне (тесты, конфиг) ждём лишний шаг.
    await sleepImpl(Math.min(pollMs, remaining));
  }
}

type TurnCancelImpl = (input: StopCancelRequest) => Promise<StopCancelResult>;
type TurnCancelStatusReader = (chatKey: string) => StopStatus;
type TurnCancelLog = (...parts: unknown[]) => void;

// Подставленные дефолты политики остановки: дальше шаги получают готовые значения.
type TurnCancelRuntime = {
  readonly url: string;
  readonly secret: string | undefined;
  readonly cancelImpl: TurnCancelImpl;
  readonly getStatusImpl: TurnCancelStatusReader;
  readonly confirmTimeoutMs: number;
  readonly logImpl: TurnCancelLog;
};

// Одна попытка отмены: запись уже назвала сессию, секрет роута уже проверен.
type TurnCancelAttempt = TurnCancelRuntime & {
  readonly secret: string;
  readonly sessionId: string;
  readonly turnId: unknown;
};

// Trace: одна точка исхода на обе двери «Стопа» — журнал не может разойтись с политикой
// остановки, потому что смотрит на её же результат (ADR-0010).
function traceStopOutcome(
  chatKey: string | null,
  status: StopStatus,
  outcome: StopOutcome,
): StopOutcome {
  traceStop(chatKey ?? "", status ?? null, outcome);
  return outcome;
}

/**
 * ЕДИНАЯ политика остановки для обеих дверей: и мост, и канал ходят сюда, поэтому
 * «что считается живым ходом» не может разъехаться между режимами.
 *
 * Отменять или нет решает ЗАПИСЬ, а не её свежесть: протухшая (старше RUN_STALE_MS)
 * или снятая жнецом запись всё ещё помнит sessionId, а ход в eve может быть жив.
 * Свежесть здесь спрашивать нельзя — молчаливое «ничего не выполняется» на живой ход
 * и есть та ложь, которую чинит этот путь. Отвечает ли ход на самом деле, выясняет
 * роут: `no_active_turn` — серверное подтверждение, что отменять нечего.
 */
export async function requestTurnCancel(
  chatKey: string | null,
  {
    url,
    secret,
    cancelImpl = requestTelegramCancel,
    getStatusImpl = getChatStatus,
    confirmTimeoutMs = STOP_CONFIRM_TIMEOUT_MS,
    logImpl = console.error,
  }: {
    url: string;
    secret?: string;
    cancelImpl?: TurnCancelImpl;
    getStatusImpl?: TurnCancelStatusReader;
    confirmTimeoutMs?: number;
    logImpl?: TurnCancelLog;
  },
): Promise<StopOutcome> {
  if (chatKey === null || chatKey.length === 0)
    return traceStopOutcome(chatKey, null, "idle");
  return cancelTurnAndConfirm(chatKey, getStatusImpl(chatKey), {
    url,
    secret,
    cancelImpl,
    getStatusImpl,
    confirmTimeoutMs,
    logImpl,
  });
}

// Что решает запись: отменять нечего — idle, конфиг без секрета — failed. Исход в
// журнал идёт вместе ИСХОДНОЙ записью: она ещё помнит, чей ход останавливали.
async function cancelTurnAndConfirm(
  chatKey: string,
  status: StopStatus,
  runtime: TurnCancelRuntime,
): Promise<StopOutcome> {
  const sessionId = cancellableSessionId(status);
  if (sessionId === null) return traceStopOutcome(chatKey, status, "idle");
  const secret = runtime.secret;
  // Без секрета вебхука роут ответит 401 — молчать об этом хуже, чем сказать «не вышло»,
  // но и эскалация тут не поможет: это не зависший агент, а неполный конфиг.
  if (!hasCancelSecret(secret)) {
    runtime.logImpl("turn cancel failed: no TELEGRAM_WEBHOOK_SECRET_TOKEN");
    return traceStopOutcome(chatKey, status, "failed");
  }
  const outcome = await sendTurnCancel(chatKey, {
    ...runtime,
    secret,
    sessionId,
    turnId: status?.turnId,
  });
  return traceStopOutcome(chatKey, status, outcome);
}

// POST на cancel-роут и ожидание терминального факта: только он отличает «отмена
// принята» от «ход действительно остановился».
async function sendTurnCancel(
  chatKey: string,
  attempt: TurnCancelAttempt,
): Promise<StopOutcome> {
  let result: StopCancelResult;
  try {
    result = await attempt.cancelImpl(
      cancelRequestBody({
        url: attempt.url,
        secret: attempt.secret,
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
      }),
    );
  } catch (error) {
    // Молчащий роут, отказ соединения, 5xx: отменять было что, ответа на отмену нет.
    // Это «агент не отвечает», а не «ход уже завершился».
    attempt.logImpl("turn cancel failed:", error);
    return "unresponsive";
  }
  // no_active_turn — сервер сам подтвердил, что отменять уже нечего.
  if (result?.status === "no_active_turn") return "idle";
  // «принято» — ещё не остановка: ждём терминальное событие в записи. Не дождались —
  // агент не отвечает, и это тот же исход, что у молчащего роута.
  const stopped = await waitForTurnStop(chatKey, attempt.sessionId, {
    getStatusImpl: attempt.getStatusImpl,
    timeoutMs: attempt.confirmTimeoutMs,
  });
  return stopped ? "requested" : "unresponsive";
}

/**
 * Нажатие ⏹ Стоп, пришедшее прямо в канал (webhook-режим). Возвращает "ignored",
 * когда нажал не тот, кому можно, или у колбэка нет сообщения-якоря: состояние не
 * трогается, а спиннер кнопки всё равно гасится без текста.
 */
export async function handleTelegramStopCallback(
  query: StopCallbackQuery,
  {
    ackImpl,
    allowedImpl = allowedTelegramUsers,
    urlImpl = localCancelUrl,
    secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    ...cancelDeps
  }: {
    ackImpl: (text?: string) => Promise<unknown>;
    allowedImpl?: () => ReadonlySet<string>;
    urlImpl?: () => string;
    secret?: string;
    cancelImpl?: (input: StopCancelRequest) => Promise<StopCancelResult>;
    getStatusImpl?: (chatKey: string) => StopStatus;
    confirmTimeoutMs?: number;
    logImpl?: (...parts: unknown[]) => void;
  },
): Promise<StopOutcome | "ignored"> {
  const from = query.from?.id;
  const allowed = allowedImpl();
  const reference = query.message;
  if (
    allowed.size === 0 ||
    from === undefined ||
    !allowed.has(String(from)) ||
    !reference
  ) {
    await ackImpl();
    return "ignored";
  }
  if (!isPrivateTelegramChat(reference.chat)) {
    await ackImpl(
      tr(
        "Open a private chat with me to use this control.",
        "Открой личный чат со мной, чтобы использовать это управление.",
      ),
    );
    return "ignored";
  }

  const outcome = await requestTurnCancel(
    chatKeyOf(reference.chat.id, reference.messageThreadId),
    { url: urlImpl(), secret, ...cancelDeps },
  );
  await ackImpl(stopOutcomeText(outcome));
  return outcome;
}
