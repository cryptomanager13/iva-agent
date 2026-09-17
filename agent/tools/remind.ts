import { randomBytes } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  nextCronRunMs,
  ownerTimeZone,
  resolveAt,
} from "../lib/reminder-time.ts";
import {
  add,
  list,
  normalizeSchedule,
  remove,
  type Reminder,
  type ReminderChat,
} from "../lib/reminder-store.ts";
import {
  chatOfTurn,
  describeReminder,
  schedulerStatus,
  toolFailure,
  type ReminderView,
  type SchedulerStatus,
} from "../lib/reminder-tool.ts";
import { formatZoned } from "../lib/zoned-time.ts";

export type RemindAdded = {
  readonly ok: true;
  readonly reminder: ReminderView;
  readonly now: string;
  readonly scheduler: SchedulerStatus;
};

export type RemindListed = {
  readonly ok: true;
  readonly count: number;
  readonly now: string;
  readonly timezone: string;
  readonly reminders: readonly ReminderView[];
  readonly scheduler: SchedulerStatus;
};

export type RemindRemoved = {
  readonly ok: true;
  readonly removed: { readonly id: string; readonly text: string };
};

export type RemindFailure = { readonly ok: false; readonly error: string };

export type RemindAnswer =
  RemindAdded | RemindListed | RemindRemoved | RemindFailure;

type Input = {
  readonly action: "add" | "list" | "remove";
  readonly text?: string;
  readonly at?: string;
  readonly cron?: string;
  readonly id?: string;
};

async function addReminder(
  { text, at, cron }: Input,
  tz: string,
  nowMs: number,
  chat: ReminderChat | null,
): Promise<RemindAdded | RemindFailure> {
  if (text === undefined)
    return { ok: false as const, error: "action add needs text" };
  if ((at === undefined) === (cron === undefined))
    return { ok: false as const, error: "give exactly one of at or cron" };
  // Напоминание возвращается туда, где его попросили (чат и тема хода). Без Telegram-хода
  // остаётся чат владельца из настроек - и тогда он обязан быть.
  if (chat === null && !notificationChat(process.env))
    return {
      ok: false as const,
      error:
        "no owner chat: set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS",
    };
  const id = `r-${randomBytes(3).toString("hex")}`;
  const answer = (row: Reminder) => ({
    ok: true as const,
    reminder: describeReminder(row, tz),
    now: formatZoned(nowMs, tz),
    scheduler: schedulerStatus(nowMs, tz),
  });
  if (at !== undefined) {
    const row = await add({
      id,
      text,
      chat,
      schedule: { kind: "at", atMs: resolveAt(at, nowMs, tz) },
    });
    return answer(row);
  }
  const schedule = normalizeSchedule({ kind: "cron", expr: cron, tz });
  if (schedule.kind !== "cron")
    return toolFailure(new Error("schedule: not a cron expression"));
  const row = await add({
    id,
    text,
    chat,
    schedule,
    nextRunAtMs: nextCronRunMs(schedule.expr, tz, nowMs),
  });
  return answer(row);
}

async function listReminders(tz: string, nowMs: number): Promise<RemindListed> {
  const rows = await list();
  return {
    ok: true as const,
    count: rows.length,
    now: formatZoned(nowMs, tz),
    timezone: tz,
    reminders: rows.map((row) => describeReminder(row, tz)),
    scheduler: schedulerStatus(nowMs, tz),
  };
}

async function removeReminder({
  id,
}: Input): Promise<RemindRemoved | RemindFailure> {
  if (id === undefined)
    return { ok: false as const, error: "action remove needs id" };
  const row = await remove(id);
  return { ok: true as const, removed: { id: row.id, text: row.text } };
}

export default defineTool({
  description:
    "Напоминания пользователю: action add | list | remove. " +
    "add - text и ровно одно из at (разовое) или cron (повторяющееся): " +
    '{"action":"add","text":"позвонить","at":"in 30m"}; время - словами пользователя ' +
    "в его зоне, сам не считай и в UTC не конвертируй: момент считает планировщик и " +
    'возвращает next_run_at, его и сообщи. list - {"action":"list"}: id, следующий срок, ' +
    "факт последнего срабатывания (fired_at, delivered, error) сутки после него. remove - " +
    '{"action":"remove","id":"r-1a2b3c"}, id только из list. Адресата не указывают: ' +
    "ответ придёт в тот чат и тему, где попросили. text - инструкция самой себе на будущее: " +
    "в срок ты проснёшься свежей сессией без этого чата и выполнишь её, финальный ответ уйдёт " +
    "в чат, где попросили; пиши текст самодостаточно (что сделать, для кого, куда). Просто " +
    "напомнить - тоже инструкция. Свой таймер шеллом (systemd-run, crontab, at, sleep, curl) запрещён и " +
    "заблокирован. scheduler.alive = false - скажи, что напоминание записано, но диспетчер " +
    "не работает.",
  inputSchema: z.object({
    action: z
      .enum(["add", "list", "remove"])
      .describe("Что сделать: поставить, показать список, снять"),
    text: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "add: инструкция самой себе на срок словами пользователя - что сделать и о чём напомнить, самодостаточно",
      ),
    at: z
      .string()
      .min(1)
      .optional()
      .describe(
        'add, разовое: "in 30m", "in 1h 30m", "14:30", "2026-09-14 09:00" (в зоне пользователя) или ISO-момент со смещением',
      ),
    cron: z
      .string()
      .min(1)
      .optional()
      .describe(
        'add, повторяющееся: cron-выражение из 5 полей в зоне пользователя, например "0 9 * * 1-5"',
      ),
    id: z.string().min(1).optional().describe("remove: id из списка"),
  }),
  async execute(input, ctx): Promise<RemindAnswer> {
    const tz = ownerTimeZone();
    const nowMs = Date.now();
    try {
      switch (input.action) {
        case "add":
          return await addReminder(input, tz, nowMs, chatOfTurn(ctx));
        case "list":
          return await listReminders(tz, nowMs);
        case "remove":
          return await removeReminder(input);
      }
    } catch (error) {
      return toolFailure(error);
    }
  },
});
