// Таблица напоминаний в data/reminders.json: строка = срок, текст и факт срабатывания.
//
// Взятие строки — один атомарный переход pending → fired: повторное срабатывание
// невозможно по построению, аренды и счётчиков попыток нет. Всё, что происходит после
// перехода, — один ход ребёнка scripts/reminders/fire.ts (агент выполняет текст напоминания,
// код отправляет его ответ); он только дописывает факт в ту же строку. Повторяющаяся строка тем
// же переходом получает следующий срок от croner и остаётся pending — факт последнего
// срабатывания при ней.
//
// Файл, записанный более новой версией Ивы, читается как явная ошибка: читать его наугад
// значит молча испортить данные следующей записью. Файл версии 1 (режимы verbatim/agent,
// аренда, счётчики провалов) переводится построчно: срок и текст сохраняются, режим и все
// политики повторов отброшены владельцем 12.09.
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";
import { nextCronRunMs } from "./reminder-time.ts";

export const REMINDER_SCHEMA_VERSION = 2;
/** Сколько держим сработавшую разовую строку: столько владелец видит факт в remind list. */
export const REMINDER_FIRED_KEEP_MS = 24 * 60 * 60_000;

export class ReminderStoreError extends Error {}

export type ReminderStatus = "pending" | "fired";
/** `at` — один точный срок; `cron` — повторяющееся расписание (cron-выражение пользователя). */
export type ReminderSchedule =
  { kind: "at"; atMs: number } | { kind: "cron"; expr: string; tz: string };
/** Куда возвращается напоминание: чат и тема, где его попросили. */
export interface ReminderChat {
  id: string;
  threadId: string | null;
}

export interface Reminder {
  id: string;
  text: string;
  /** null - строка старой схемы или запрос не из Telegram: тогда чат владельца из настроек. */
  chat: ReminderChat | null;
  schedule: ReminderSchedule;
  nextRunAtMs: number;
  createdAt: number;
  /** pending — ждёт своего срока; fired — разовая уже сработала и ждёт уборки через сутки. */
  status: ReminderStatus;
  /** Когда строка сработала в последний раз; null — ещё ни разу. */
  firedAt: number | null;
  /** Дошёл ли текст до чата владельца; null — ребёнок ещё не сказал. */
  delivered: boolean | null;
  /** Причина последнего сбоя — отправки или хода агента. */
  error: string | null;
}
export type ReminderInput = {
  id: string;
  text: string;
  chat?: ReminderChat | null;
  schedule: unknown;
  /** Обязателен для kind "cron", запрещён для kind "at". */
  nextRunAtMs?: number;
};

const ROW_KEYS = [
  "id",
  "text",
  "chat",
  "schedule",
  "nextRunAtMs",
  "createdAt",
  "status",
  "firedAt",
  "delivered",
  "error",
] as const;

function fail(file: string, message: string): never {
  throw new ReminderStoreError(`${file}: ${message}`);
}

function badReminder(file: string, idLabel: string, message: string): never {
  fail(file, `reminder ${idLabel}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

/**
 * Форма расписания, а не его смысл: арифметика следующего запуска для повторяющегося
 * расписания живёт выше этого модуля. Идемпотентна: нормализованное расписание
 * нормализуется в себя.
 */
export function normalizeSchedule(input: unknown): ReminderSchedule {
  if (!isPlainObject(input))
    throw new ReminderStoreError(
      `schedule must be an object, got ${JSON.stringify(input)}`,
    );

  if (input.kind === "at") {
    if (!hasExactKeys(input, ["kind", "atMs"]))
      throw new ReminderStoreError(
        `schedule: kind "at" takes exactly kind and atMs, got ${JSON.stringify(input)}`,
      );
    if (!isSafeInt(input.atMs) || input.atMs < 0)
      throw new ReminderStoreError(
        `schedule: atMs must be a safe integer >= 0, got ${JSON.stringify(input.atMs)}`,
      );
    return { kind: "at", atMs: input.atMs };
  }

  if (input.kind === "cron") {
    if (!hasExactKeys(input, ["kind", "expr", "tz"]))
      throw new ReminderStoreError(
        `schedule: kind "cron" takes exactly kind, expr and tz, got ${JSON.stringify(input)}`,
      );
    if (typeof input.expr !== "string")
      throw new ReminderStoreError(
        `schedule: expr must be a string, got ${JSON.stringify(input.expr)}`,
      );
    const expr = input.expr.trim().replace(/\s+/gu, " ");
    const fields = expr.split(" ");
    if (fields.length !== 5)
      throw new ReminderStoreError(
        `schedule: expr must have exactly 5 fields, got ${fields.length}: ${JSON.stringify(input.expr)}`,
      );
    for (const field of fields) {
      if (!/^[0-9*,/-]+$/u.test(field))
        throw new ReminderStoreError(
          `schedule: expr field ${JSON.stringify(field)} is not a cron field`,
        );
    }
    if (typeof input.tz !== "string" || input.tz.length === 0)
      throw new ReminderStoreError(
        `schedule: tz must be a non-empty string, got ${JSON.stringify(input.tz)}`,
      );
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.tz });
    } catch {
      throw new ReminderStoreError(
        `schedule: tz ${JSON.stringify(input.tz)} is not a known IANA time zone`,
      );
    }
    return { kind: "cron", expr, tz: input.tz };
  }

  throw new ReminderStoreError(
    `schedule: kind must be "at" or "cron", got ${JSON.stringify(input.kind)}`,
  );
}

/** Одна проверка формы строки и для add, и для загрузки файла. */
/** Чат строки: null или {id, threadId}; чужая форма - ошибка строки, не тихий null. */
function assertChat(
  file: string,
  idLabel: string,
  value: unknown,
): ReminderChat | null {
  if (value === null || value === undefined) return null;
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    (value.threadId !== null && typeof value.threadId !== "string")
  )
    badReminder(
      file,
      idLabel,
      `chat must be null or {id, threadId}, got ${JSON.stringify(value)}`,
    );
  return { id: value.id, threadId: value.threadId };
}

function assertReminder(file: string, value: unknown): Reminder {
  if (!isPlainObject(value))
    fail(file, `reminder row must be an object, got ${JSON.stringify(value)}`);

  const idLabel = JSON.stringify(value.id);

  for (const key of Object.keys(value)) {
    if (!(ROW_KEYS as readonly string[]).includes(key))
      badReminder(file, idLabel, `unknown key ${JSON.stringify(key)}`);
  }

  const id = value.id;
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id)
    fail(
      file,
      `id must be a non-empty string without surrounding whitespace, got ${idLabel}`,
    );

  if (typeof value.text !== "string" || value.text.trim().length === 0)
    badReminder(file, idLabel, "text must be a non-empty string");

  let schedule: ReminderSchedule;
  try {
    schedule = normalizeSchedule(value.schedule);
  } catch (error) {
    badReminder(file, idLabel, (error as Error).message);
  }

  if (!isSafeInt(value.nextRunAtMs) || value.nextRunAtMs < 0)
    badReminder(
      file,
      idLabel,
      `nextRunAtMs must be a safe integer >= 0, got ${JSON.stringify(value.nextRunAtMs)}`,
    );

  if (!isSafeInt(value.createdAt) || value.createdAt < 0)
    badReminder(
      file,
      idLabel,
      `createdAt must be a safe integer >= 0, got ${JSON.stringify(value.createdAt)}`,
    );

  const status = value.status;
  if (status !== "pending" && status !== "fired")
    badReminder(
      file,
      idLabel,
      `status must be "pending" or "fired", got ${JSON.stringify(status)}`,
    );

  const firedAt = value.firedAt;
  if (firedAt !== null && (!isSafeInt(firedAt) || firedAt < 0))
    badReminder(
      file,
      idLabel,
      `firedAt must be null or a safe integer >= 0, got ${JSON.stringify(firedAt)}`,
    );
  if (status === "fired" && firedAt === null)
    badReminder(file, idLabel, "fired row has no firedAt");

  const delivered = value.delivered;
  if (delivered !== null && typeof delivered !== "boolean")
    badReminder(
      file,
      idLabel,
      `delivered must be null, true or false, got ${JSON.stringify(delivered)}`,
    );

  const error = value.error;
  if (error !== null && typeof error !== "string")
    badReminder(
      file,
      idLabel,
      `error must be null or a string, got ${JSON.stringify(error)}`,
    );

  return {
    id,
    text: value.text,
    // Строки до этого поля чата не несут: им остаётся чат владельца из настроек.
    chat: assertChat(file, idLabel, value.chat),
    schedule,
    nextRunAtMs: value.nextRunAtMs,
    createdAt: value.createdAt,
    status,
    firedAt,
    delivered,
    error,
  };
}

/**
 * Строка версии 1: режим доставки, аренда и счётчики провалов отброшены, срок, текст и факт
 * последней попытки сохранены. Разовой строке, которая уже пыталась сработать, ставится
 * fired — иначе она сработала бы второй раз; повторяющаяся остаётся pending на свой срок.
 */
function migrateV1Row(
  file: string,
  value: unknown,
  nowMs: number,
): Record<string, unknown> {
  if (!isPlainObject(value))
    fail(file, `reminder row must be an object, got ${JSON.stringify(value)}`);

  let schedule: ReminderSchedule;
  try {
    schedule = normalizeSchedule(value.schedule);
  } catch (error) {
    badReminder(file, JSON.stringify(value.id), (error as Error).message);
  }
  const firedAt =
    typeof value.lastRunAtMs === "number" &&
    Number.isSafeInteger(value.lastRunAtMs)
      ? value.lastRunAtMs
      : null;
  const alreadyRan = firedAt !== null;
  return {
    id: value.id,
    text: value.text,
    chat: null,
    schedule,
    nextRunAtMs: value.nextRunAtMs,
    createdAt: nowMs,
    status: schedule.kind === "at" && alreadyRan ? "fired" : "pending",
    firedAt,
    delivered: alreadyRan ? value.lastStatus === "ok" : null,
    error: typeof value.lastError === "string" ? value.lastError : null,
  };
}

/** Путь считается на каждом вызове: тесты меняют ASSISTANT_DATA_DIR между кейсами. */
export function reminderFile(): string {
  return join(dataDir(), "reminders.json");
}

async function loadTable(file: string): Promise<Reminder[]> {
  const raw = await loadJsonStrict<unknown>(file, {
    schemaVersion: REMINDER_SCHEMA_VERSION,
    rows: [],
  });
  return parseReminderTable(file, raw, Date.now());
}

/**
 * Разбор таблицы без файла — тот же, что у `list()`: `iva diagnose` читает файл сам (клиент
 * грузится без authored tree и не имеет права на побочный эффект читателя: порченый JSON
 * стор откладывает в сторону), но полей строки и перевода v1 второй копией не держит.
 */
export function parseReminderTable(
  file: string,
  raw: unknown,
  nowMs: number,
): Reminder[] {
  if (!isPlainObject(raw) || typeof raw.schemaVersion !== "number")
    fail(file, "no schemaVersion");
  const version = raw.schemaVersion;
  if (!Number.isInteger(version))
    fail(file, `unsupported schemaVersion ${JSON.stringify(version)}`);
  if (version > REMINDER_SCHEMA_VERSION)
    fail(
      file,
      `schemaVersion ${version} is newer than this Iva (${REMINDER_SCHEMA_VERSION}); update Iva or restore the file`,
    );
  if (version < 1) fail(file, `unsupported schemaVersion ${version}`);

  if (!Array.isArray(raw.rows))
    fail(file, `rows must be an array, got ${JSON.stringify(raw.rows)}`);

  const seen = new Set<string>();
  const rows: Reminder[] = [];
  for (const value of raw.rows) {
    const reminder =
      version === 1
        ? assertReminder(file, migrateV1Row(file, value, nowMs))
        : assertReminder(file, value);
    if (seen.has(reminder.id))
      fail(file, `duplicate reminder id ${JSON.stringify(reminder.id)}`);
    seen.add(reminder.id);
    rows.push(reminder);
  }
  return rows;
}

async function saveTable(file: string, rows: Reminder[]): Promise<void> {
  await saveJsonAtomic(
    file,
    { schemaVersion: REMINDER_SCHEMA_VERSION, rows },
    { mode: 0o600 },
  );
}

/** Мутации — под локом: тик и живой чат ходят в один файл из одного процесса. */
async function mutate<T>(file: string, run: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    return await run();
  } finally {
    releaseLock(lock, token);
  }
}

function byDeadline(a: Reminder, b: Reminder): number {
  if (a.nextRunAtMs !== b.nextRunAtMs) return a.nextRunAtMs - b.nextRunAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildReminder(
  file: string,
  input: ReminderInput,
): Record<string, unknown> {
  const idLabel = JSON.stringify(input.id);

  // Чужой ключ во входе — ошибка, а не тихо отброшенное поле: старый вызов с mode или
  // deliver (схема версии 1) должен упасть, а не записать напоминание без того, что просили.
  for (const key of Object.keys(input)) {
    if (
      key !== "id" &&
      key !== "text" &&
      key !== "chat" &&
      key !== "schedule" &&
      key !== "nextRunAtMs"
    )
      badReminder(file, idLabel, `unknown input key ${JSON.stringify(key)}`);
  }

  let schedule: ReminderSchedule;
  try {
    schedule = normalizeSchedule(input.schedule);
  } catch (error) {
    badReminder(file, idLabel, (error as Error).message);
  }

  let nextRunAtMs: number;
  if (schedule.kind === "at") {
    if (input.nextRunAtMs !== undefined)
      badReminder(file, idLabel, 'nextRunAtMs is not allowed for kind "at"');
    nextRunAtMs = schedule.atMs;
  } else {
    if (input.nextRunAtMs === undefined)
      badReminder(file, idLabel, 'nextRunAtMs is required for kind "cron"');
    if (!isSafeInt(input.nextRunAtMs) || input.nextRunAtMs < 0)
      badReminder(
        file,
        idLabel,
        `nextRunAtMs must be a safe integer >= 0, got ${JSON.stringify(input.nextRunAtMs)}`,
      );
    nextRunAtMs = input.nextRunAtMs;
  }

  return {
    id: input.id,
    text: input.text,
    chat: assertChat(file, idLabel, input.chat ?? null),
    schedule,
    nextRunAtMs,
    createdAt: Date.now(),
    status: "pending",
    firedAt: null,
    delivered: null,
    error: null,
  };
}

export async function add(input: ReminderInput): Promise<Reminder> {
  const file = reminderFile();
  const row = buildReminder(file, input);
  return mutate(file, async () => {
    const rows = await loadTable(file);
    if (rows.some((candidate) => candidate.id === row.id))
      fail(file, `duplicate reminder id ${JSON.stringify(row.id)}`);
    const reminder = assertReminder(file, row);
    rows.push(reminder);
    await saveTable(file, rows);
    return structuredClone(reminder);
  });
}

export async function list(): Promise<Reminder[]> {
  const rows = await loadTable(reminderFile());
  return rows.sort(byDeadline).map((row) => structuredClone(row));
}

export async function remove(id: string): Promise<Reminder> {
  const file = reminderFile();
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) fail(file, `reminder ${JSON.stringify(id)} not found`);
    const [removed] = rows.splice(index, 1);
    await saveTable(file, rows);
    return structuredClone(removed);
  });
}

/**
 * Срабатывание: pending-строки со сроком не позже nowMs переходят в fired и получают
 * firedAt — один атомарный переход под локом, поэтому два тика не могут взять одну строку.
 * Повторяющаяся строка тем же переходом пересчитывается на следующий срок и остаётся
 * pending: её факт срабатывания (firedAt) уже проставлен, а доставку допишет ребёнок.
 *
 * Расписание, которое croner отвергает (в файл могло попасть что угодно), не роняет тик и
 * не крутит строку: она уходит в fired с ошибкой в поле error — владелец увидит её в
 * remind list и iva doctor, а сама строка больше не сработает.
 */
export async function fireDue(
  nowMs: number,
  limit: number,
): Promise<Reminder[]> {
  const file = reminderFile();
  if (!isSafeInt(nowMs) || nowMs < 0)
    fail(
      file,
      `nowMs must be a safe integer >= 0, got ${JSON.stringify(nowMs)}`,
    );
  if (!isSafeInt(limit) || limit < 1)
    fail(
      file,
      `limit must be a safe integer >= 1, got ${JSON.stringify(limit)}`,
    );

  return mutate(file, async () => {
    const rows = await loadTable(file);
    const due = rows
      .filter((row) => row.status === "pending" && row.nextRunAtMs <= nowMs)
      .sort(byDeadline)
      .slice(0, limit);
    if (due.length === 0) return [];

    for (const row of due) {
      row.firedAt = nowMs;
      row.delivered = null;
      row.error = null;
      if (row.schedule.kind === "cron") {
        try {
          row.nextRunAtMs = nextCronRunMs(
            row.schedule.expr,
            row.schedule.tz,
            nowMs,
          );
        } catch (error) {
          row.status = "fired";
          row.error = `cron: ${(error as Error).message}`;
          row.delivered = false;
        }
      } else {
        row.status = "fired";
      }
    }
    await saveTable(file, rows);
    return due.map((row) => structuredClone(row));
  });
}

/**
 * Факт отправки. Успех не стирает уже записанную причину, провал отправки называет
 * свою (она и есть главная для владельца). Результат принимается
 * только за своё срабатывание: firedAt результата обязан совпасть с firedAt строки,
 * иначе запоздалый ответ старого срока переписал бы факт нового — такой результат
 * уходит в журнал и отбрасывается. `delivered: null` — факта нет (текст мог уйти, а
 * запись не состояться): строка остаётся без факта, `error` называет причину.
 */
export async function recordDelivery(
  id: string,
  outcome: {
    readonly firedAt: number | null;
    readonly delivered: boolean | null;
    readonly error: string | null;
  },
  options: ReminderRecordOptions = {},
): Promise<Reminder> {
  const file = reminderFile();
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined)
      fail(file, `reminder ${JSON.stringify(id)} not found`);
    if (row.firedAt !== outcome.firedAt) {
      recordLog(options)(
        `reminders: ${id} delivery result for firedAt=${outcome.firedAt} ignored: current firedAt=${row.firedAt}`,
      );
      return structuredClone(row);
    }
    row.delivered = outcome.delivered;
    if (outcome.error !== null) row.error = outcome.error;
    await saveTable(file, rows);
    return structuredClone(row);
  });
}

/** Журнал отброшенного результата: по умолчанию в stdout, как у планировщика. */
export interface ReminderRecordOptions {
  readonly log?: (...args: unknown[]) => void;
}

function recordLog(
  options: ReminderRecordOptions,
): (...args: unknown[]) => void {
  return (
    options.log ??
    ((...args: unknown[]) => console.log(new Date().toISOString(), ...args))
  );
}

/** Уборка: сработавшие разовые строки живут сутки — столько владелец видит факт. */
export async function sweepFired(
  nowMs: number,
  keepMs: number = REMINDER_FIRED_KEEP_MS,
): Promise<number> {
  const file = reminderFile();
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const kept = rows.filter(
      (row) =>
        !(
          row.status === "fired" &&
          row.firedAt !== null &&
          row.firedAt <= nowMs - keepMs
        ),
    );
    const swept = rows.length - kept.length;
    if (swept > 0) await saveTable(file, kept);
    return swept;
  });
}
