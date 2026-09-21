// Остановка хода по кнопке ⏹ Стоп: синхронная попытка отмены, честные тексты исхода и
// ожидание терминального подтверждения.
//
// Дверей две, и обе кончаются одним cancel-роутом канала:
//  - long-poll (штатный режим): нажатие ловит МОСТ (scripts/poller/control.ts) и зовёт
//    роут сам — так «Стоп» доходит даже до занятого агента;
//  - webhook-режим: моста нет вовсе, апдейт идёт прямо в eve, и нажатие ловит
//    onCallbackQuery канала — этот модуль.
// В long-poll мост съедает колбэк раньше (scripts/poller/main.ts зовёт handleControl
// до любой доставки), поэтому здешний путь там не срабатывает. Двойное срабатывание
// безопасно и так: cancel идемпотентен, `no_active_turn` — тоже успех.
//
// Синхронная часть делает ровно одно: спрашивает роут. Ответу «принято» верить нельзя —
// ход заканчивает терминальное turn.cancelled, и видно его только по записи run-status, —
// поэтому ждёт подтверждения не цикл, а фон: мост отдаёт ожидание фоновой задаче, канал —
// своей вебхук-задаче (после ответа на колбэк). Окно ожидания и тексты общие, чтобы двери
// не разъехались.

import { requestTelegramCancel } from "./telegram-cancel-client.ts";
import { localCancelUrl } from "./telegram-cancel-route.ts";
import { allowedTelegramUsers } from "./telegram-allowlist.ts";
import { chatKeyOf, getChatStatus } from "./run-status.ts";
import { tr } from "./i18n.ts";
import { isPrivateTelegramChat } from "./telegram-private-chat.ts";
import { traceStop } from "./trace.ts";

// Исходы не смешиваются: «отмену запросили, ждём факта», «отменять нечего» и «отменить не
// вышло из-за конфига» — разные факты с разным следующим шагом. Ответил ли роут и пришло ли
// подтверждение — тоже разные вещи: первое видно здесь, второе только по записи.
export type StopOutcome = "requested" | "unresponsive" | "idle" | "failed";
// Что вообще говорится в ответ на попытку: у «роут молчит» своего текста нет — это ещё не
// исход хода, о нём скажет фоновое ожидание, если ход так и не остановится.
export type StopReplyOutcome = Exclude<StopOutcome, "unresponsive">;
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

// Ответ на попытку отмены: у «отмены в пути» (роут ответил или промолчал) он один.
export function isPendingStopOutcome(outcome: StopOutcome): boolean {
  return outcome === "requested" || outcome === "unresponsive";
}

export function replyOutcomeOf(outcome: StopOutcome): StopReplyOutcome {
  return outcome === "unresponsive" ? "requested" : outcome;
}

// Функция, а не const: перевод выбирается в момент вызова (правило репо).
export function stopOutcomeText(outcome: StopReplyOutcome): string {
  if (outcome === "requested") return tr("Stopping…", "Останавливаю…");
  if (outcome === "idle")
    return tr("Nothing is running right now.", "Сейчас ничего не выполняется.");
  return tr("Couldn't stop the turn.", "Не удалось остановить ход.");
}

// Честный текст, когда за окно подтверждения ход так и не остановился. Формулировка
// нейтральная: отмену мог не услышать инструмент, а не агент — обвинять некого.
export function stopNotStoppedText(seconds: number): string {
  return tr(
    `The turn hasn't stopped within ${seconds}s.`,
    `Ход не остановился за ${seconds} с.`,
  );
}

// Предупреждение рядом с кнопкой рестарта: он рвёт ходы во всех чатах сразу.
export function stopRestartWarningText(): string {
  return tr(
    "Restarting Iva will interrupt work in every chat.",
    "Перезапуск Iva оборвёт работу во всех чатах.",
  );
}

// Кнопка — обычная inline-кнопка ряда (не rich message): её клавиатуру снимает правка,
// а по старому нажатию решается, жив ли ещё тот ход.
export function stopRestartButtonText(): string {
  return tr("🔁 Restart Iva", "🔁 Перезапустить Iva");
}

export function stopAlreadyStoppedText(): string {
  return tr("This turn is over already.", "Этот ход уже завершился.");
}

export function stopRestartingText(): string {
  return tr("♻️ Restarting Iva", "♻️ Перезапускаю Iva");
}

export function stopRestartAlreadyText(): string {
  return tr("♻️ Iva is restarting already", "♻️ Перезапуск Iva уже идёт");
}

export function stopRestartedText(): string {
  return tr("♻️ Iva restarted", "♻️ Iva перезапущена");
}

export function stopRestartFailedText(): string {
  return tr("⚠️ Couldn't restart Iva", "⚠️ Не удалось перезапустить Iva");
}

// Окно, за которое ход обязан подтвердить остановку, — в секундах: столько называет текст.
// Ответ роута «принято» остановкой ещё не является: ход заканчивает turn.cancelled, и его
// видно по записи run-status. Подход тот же, что у ночного роллапа
// (scripts/lib/rollup-turn.ts): факт подтверждает терминальное событие, а не HTTP-ответ;
// разница только в источнике факта — там поток хода, здесь запись.
export const STOP_CONFIRM_TIMEOUT_MS = 60_000;
// Как часто фон перечитывает запись: шаг опроса — деталь ожидания, наружу не выходит.
const STOP_CONFIRM_POLL_MS = 500;

// Сколько секунд называет текст «ход не остановился»: число берётся из того же окна, которое
// реально отработало. Меньше секунды окна не бывает нигде, кроме тестов, а ноль в тексте
// читался бы как ошибка.
export function stopConfirmSeconds(
  timeoutMs = STOP_CONFIRM_TIMEOUT_MS,
): number {
  return Math.max(1, Math.round(timeoutMs / 1000));
}

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

export async function waitForTurnStop(
  chatKey: string,
  sessionId: string,
  {
    getStatusImpl = getChatStatus,
    timeoutMs = STOP_CONFIRM_TIMEOUT_MS,
    pollMs = STOP_CONFIRM_POLL_MS,
    now = Date.now,
    sleepImpl = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    getStatusImpl?: (chatKey: string) => StopStatus;
    timeoutMs?: number;
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
  readonly logImpl: TurnCancelLog;
};

// Одна попытка отмены: запись уже назвала сессию, секрет роута уже проверен.
type TurnCancelAttempt = TurnCancelRuntime & {
  readonly secret: string;
  readonly sessionId: string;
  readonly turnId: unknown;
};

// Как ждут подтверждение оба вызывающих: окно и опрос подменяются в тестах.
type TurnStopWait = {
  readonly getStatusImpl?: TurnCancelStatusReader;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleepImpl?: (ms: number) => Promise<void>;
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
    logImpl = console.error,
  }: {
    url: string;
    secret?: string;
    cancelImpl?: TurnCancelImpl;
    getStatusImpl?: TurnCancelStatusReader;
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
  const outcome = await sendTurnCancel({
    ...runtime,
    secret,
    sessionId,
    turnId: status?.turnId,
  });
  return traceStopOutcome(chatKey, status, outcome);
}

// POST на cancel-роут: синхронная часть пути «Стоп». Что роут ответил — journal, а не
// истина: «принято» лишь значит, что сигнал отмены взят, поэтому наружу уходит
// «отмена в пути», а факт остановки смотрит фоновое ожидание.
async function sendTurnCancel(
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
    // Ход при этом мог не остановиться — это выяснит фоновое ожидание.
    attempt.logImpl("turn cancel failed:", error);
    return "unresponsive";
  }
  // no_active_turn — сервер сам подтвердил, что отменять уже нечего.
  return result?.status === "no_active_turn" ? "idle" : "requested";
}

// Кому и куда можно жать ⏹: чужой тап и тап в группе только гасят спиннер — ни отмены, ни
// состояния. Дальше работу ведёт ключ чата: он же помнит тему.
async function stopTapChatKey(
  query: StopCallbackQuery,
  ackImpl: (text?: string) => Promise<unknown>,
  allowedImpl: () => ReadonlySet<string>,
): Promise<string | null> {
  const from = query.from?.id;
  const reference = query.message;
  const known = allowedImpl();
  if (
    known.size === 0 ||
    from === undefined ||
    !known.has(String(from)) ||
    !reference
  ) {
    await ackImpl();
    return null;
  }
  if (!isPrivateTelegramChat(reference.chat)) {
    await ackImpl(
      tr(
        "Open a private chat with me to use this control.",
        "Открой личный чат со мной, чтобы использовать это управление.",
      ),
    );
    return null;
  }
  return chatKeyOf(reference.chat.id, reference.messageThreadId);
}

/**
 * Нажатие ⏹ Стоп, пришедшее прямо в канал (webhook-режим). Возвращает "ignored",
 * когда нажал не тот, кому можно, или у колбэка нет сообщения-якоря: состояние не
 * трогается, а спиннер кнопки всё равно гасится без текста.
 *
 * Ответ на колбэк уходит СРАЗУ после попытки отмены: подтверждение — дело фона, иначе
 * Telegram отверг бы ответ как устаревший. Ждёт его эта же вебхук-задача, а не цикл
 * моста (которого в этом режиме нет).
 */
export async function handleTelegramStopCallback(
  query: StopCallbackQuery,
  {
    ackImpl,
    notifyImpl = async () => {},
    allowedImpl = allowedTelegramUsers,
    urlImpl = localCancelUrl,
    secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    confirmTimeoutMs = STOP_CONFIRM_TIMEOUT_MS,
    ...cancelDeps
  }: {
    ackImpl: (text?: string) => Promise<unknown>;
    notifyImpl?: (text: string) => Promise<unknown>;
    allowedImpl?: () => ReadonlySet<string>;
    urlImpl?: () => string;
    secret?: string;
    cancelImpl?: TurnCancelImpl;
    getStatusImpl?: TurnCancelStatusReader;
    confirmTimeoutMs?: number;
    logImpl?: TurnCancelLog;
  },
): Promise<StopOutcome | "ignored"> {
  const chatKey = await stopTapChatKey(query, ackImpl, allowedImpl);
  if (chatKey === null) return "ignored";
  const outcome = await requestTurnCancel(chatKey, {
    url: urlImpl(),
    secret,
    ...cancelDeps,
  });
  await ackImpl(stopOutcomeText(replyOutcomeOf(outcome)));
  if (isPendingStopOutcome(outcome)) {
    await notifyIfTurnNotStopped(chatKey, {
      getStatusImpl: cancelDeps.getStatusImpl,
      logImpl: cancelDeps.logImpl,
      notifyImpl,
      timeoutMs: confirmTimeoutMs,
    });
  }
  return outcome;
}

// Подтверждение после ack. Моста в webhook-режиме нет, поэтому ждёт его сама вебхук-задача
// и говорит честно, если ход так и не остановился. Кнопки рестарта тут нет: рестарт делает
// мост, а в этом режиме его нет вовсе.
async function notifyIfTurnNotStopped(
  chatKey: string,
  {
    getStatusImpl = getChatStatus,
    logImpl = console.error,
    notifyImpl,
    timeoutMs,
  }: TurnStopWait & {
    readonly logImpl?: TurnCancelLog;
    readonly notifyImpl: (text: string) => Promise<unknown>;
  },
): Promise<void> {
  const sessionId = cancellableSessionId(getStatusImpl(chatKey));
  if (sessionId === null) return;
  if (await waitForTurnStop(chatKey, sessionId, { getStatusImpl, timeoutMs }))
    return;
  try {
    await notifyImpl(stopNotStoppedText(stopConfirmSeconds(timeoutMs)));
  } catch (error) {
    logImpl("stop notice failed:", error);
  }
}
