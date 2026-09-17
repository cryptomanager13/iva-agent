// Срабатывание одного напоминания:
//   node --env-file-if-exists=.env scripts/reminders/fire.ts <id>
// Запускает её минутный тик (agent/lib/reminder-tick.ts) на строке, которую уже перевёл в
// fired. В срок идёт один ход агента: текст напоминания — это промпт, агент выполняет его
// свежей сессией с инструментами, а код отправляет финальный текст хода в чат и тему, где
// напоминание попросили. Ход упал, вышел со status "failed" или промолчал — код шлёт сам
// текст напоминания как есть; это единственная оставшаяся отправка «текста как есть».
// Повторов нет по решению владельца 12.09: одна попытка хода, одна отправка. Факт
// (delivered/error) дописывается в ту же строку; если процесс упал, не сказав факта, тик
// запишет delivered=false с причиной по коду выхода.
//
// Живёт в scripts/, а не в agent/: выталкивание наружу идёт через Telegram и клиента eve
// (scripts/authored-tree-guard.test.ts: agent/ не импортирует scripts/).
// Коды выхода: 0 — срабатывание отработало; 2 — вызов без id или неизвестный id.
import { isEntrypoint } from "../lib/version-layout.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  list,
  recordDelivery,
  type Reminder,
  type ReminderChat,
} from "#lib/reminder-store.ts";
import { resolveTimeZone } from "#lib/timezone.ts";
import { formatZoned } from "#lib/zoned-time.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import {
  reminderClientOptions,
  reminderPrompt,
  runReminderTurn,
} from "../lib/reminder-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";

const USAGE = "usage: fire.ts <reminder id>";

export type ReminderFireDependencies = {
  readonly env?: NodeJS.ProcessEnv;
  readonly list?: typeof list;
  readonly recordDelivery?: typeof recordDelivery;
  readonly send?: typeof sendTelegramHtml;
  readonly runTurn?: typeof runReminderTurn;
  readonly chat?: (env: NodeJS.ProcessEnv) => string | null;
  readonly translator?: typeof noticeTranslator;
  readonly log?: (...args: unknown[]) => void;
};

type Wiring = Required<ReminderFireDependencies>;

const DEFAULTS: Wiring = {
  env: process.env,
  list,
  recordDelivery,
  send: sendTelegramHtml,
  runTurn: runReminderTurn,
  chat: notificationChat,
  translator: noticeTranslator,
  log: (...args: unknown[]) => console.log(...args),
};

/** Куда и чем отправлять: разобранный адресат срабатывания. */
type Target = {
  readonly token: string;
  readonly chat: string;
  readonly threadId: string | null;
};

/** Либо адресат, либо причина, по которой отправить некуда. */
type Route = { readonly target: Target } | { readonly reason: string };

/** Что отправлять и чем кончился ход: причина есть, только если текст хода не дошёл до кода. */
type Outcome = { readonly text: string; readonly error: string | null };

/** Итог отправки: причина есть, только если Telegram отказал. */
type Sent = { readonly delivered: boolean; readonly error: string | null };

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function botToken(env: NodeJS.ProcessEnv): string {
  return String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
}

/** Чат строки; у строк старой схемы и запросов не из Telegram — чат владельца из настроек. */
function chatOf(row: Reminder, deps: Wiring): ReminderChat | null {
  const owner = deps.chat(deps.env);
  return row.chat ?? (owner === null ? null : { id: owner, threadId: null });
}

function route(row: Reminder, deps: Wiring): Route {
  const token = botToken(deps.env);
  const chat = chatOf(row, deps);
  if (token === "")
    return { reason: "TELEGRAM_BOT_TOKEN is missing - run: iva config" };
  if (chat === null)
    return {
      reason:
        "no owner chat: set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS",
    };
  return { target: { token, chat: chat.id, threadId: chat.threadId } };
}

/** Пустой ответ хода — такой же провал, как упавший ход: владелец получает текст строки. */
function textOrFallback(reply: string | undefined, fallback: string): Outcome {
  const text = (reply ?? "").trim();
  return text === ""
    ? { text: fallback, error: "agent turn returned no text" }
    : { text, error: null };
}

/** status "waiting" — нормальный конец хода у eve (T40), провалом остаётся только "failed". */
function replyOf(
  turn: { readonly status: string; readonly message?: string },
  fallback: string,
): Outcome {
  if (turn.status === "failed")
    return {
      text: fallback,
      error: `agent turn failed: ${turn.message ?? "unknown"}`,
    };
  return textOrFallback(turn.message, fallback);
}

/** Один ход агента по тексту напоминания. Любой его провал отдаётся текстом строки. */
async function agentOutcome(row: Reminder, deps: Wiring): Promise<Outcome> {
  const tz = resolveTimeZone(deps.env.ASSISTANT_TIMEZONE);
  const tr = await deps.translator(deps.env);
  const prompt = reminderPrompt(
    {
      id: row.id,
      text: row.text,
      scheduledAt: formatZoned(row.firedAt ?? row.nextRunAtMs, tz),
    },
    tr,
  );
  try {
    const turn = await deps.runTurn(prompt, reminderClientOptions(deps.env), {
      log: deps.log,
    });
    return replyOf(turn, row.text);
  } catch (error) {
    return { text: row.text, error: `agent turn failed: ${message(error)}` };
  }
}

function deliveryLine(id: string, sent: Sent): string {
  return sent.error === null
    ? `reminders: ${id} delivered`
    : `reminders: ${id} not delivered: ${sent.error}`;
}

async function deliver(
  row: Reminder,
  target: Target,
  text: string,
  deps: Wiring,
): Promise<Sent> {
  const result = await deps.send(target.token, target.chat, text, {
    retryTransient: true,
    threadId: target.threadId ?? undefined,
    trace: { source: "reminder" },
  });
  const sent = { delivered: result.ok, error: result.ok ? null : result.error };
  deps.log(deliveryLine(row.id, sent));
  return sent;
}

/**
 * Запись факта — отдельная забота: её падение (лок, диск) не валит срабатывание и не меняет
 * итог отправки, но остаётся видимым в журнале.
 */
async function recordFact(
  row: Reminder,
  sent: Sent,
  error: string | null,
  deps: Wiring,
): Promise<void> {
  try {
    await deps.recordDelivery(
      row.id,
      { firedAt: row.firedAt, delivered: sent.delivered, error },
      { log: deps.log },
    );
  } catch (failure) {
    deps.log(
      `reminders: ${row.id} delivery fact not recorded: ${message(failure)}`,
    );
  }
}

/** Провал хода виден в журнале, а не только в строке: docs/reminders.md обещает его там. */
function noteTurnFailure(row: Reminder, outcome: Outcome, deps: Wiring): void {
  if (outcome.error !== null) deps.log(`reminders: ${row.id} ${outcome.error}`);
}

/** Сломаться могли оба шва: в строку идут обе причины, ни одна не теряется. */
function reason(outcome: Outcome, sent: Sent): string | null {
  const parts = [outcome.error, sent.error].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join("; ");
}

/** Ход, отправка, факт. Без адресата ход не запускается: жечь токены некуда. */
async function fireRow(row: Reminder, deps: Wiring): Promise<void> {
  const routed = route(row, deps);
  if (!("target" in routed)) {
    deps.log(`reminders: ${row.id} not delivered: ${routed.reason}`);
    await recordFact(
      row,
      { delivered: false, error: null },
      routed.reason,
      deps,
    );
    return;
  }
  const outcome = await agentOutcome(row, deps);
  noteTurnFailure(row, outcome, deps);
  const sent = await deliver(row, routed.target, outcome.text, deps);
  await recordFact(row, sent, reason(outcome, sent), deps);
}

/** Строка срабатывания или код выхода: чужой id и нечитаемая таблица заканчивают ребёнка. */
async function loadRow(id: string, deps: Wiring): Promise<Reminder | number> {
  let rows: readonly Reminder[];
  try {
    rows = await deps.list();
  } catch (error) {
    console.error(`reminders: ${id}: ${message(error)}`);
    return 1;
  }
  const row = rows.find((candidate) => candidate.id === id);
  if (row !== undefined) return row;
  console.error(`reminders: ${id}: unknown id`);
  return 2;
}

/**
 * Одно срабатывание. Возвращает код выхода вместо process.exit: так его проверяет тест, а
 * точку входа закрывает нижний `isEntrypoint`.
 */
export async function runReminderFire(
  id: string,
  dependencies?: ReminderFireDependencies,
): Promise<number> {
  if (id.trim() === "") {
    console.error(USAGE);
    return 2;
  }
  const deps: Wiring = { ...DEFAULTS, ...dependencies };
  const row = await loadRow(id, deps);
  if (typeof row === "number") return row;
  await fireRow(row, deps);
  return 0;
}

if (isEntrypoint(import.meta.url))
  process.exit(await runReminderFire(process.argv[2] ?? ""));
