// Reminders dispatcher (docs/reminders.md): ticks every minute, claims the
// due rows of data/reminders.json and hands each one to scripts/reminders/fire.ts in its
// own child process (the authored tree cannot import the Telegram transport, see
// scripts/authored-tree-guard.test.ts). No runScheduledJob status entry: the reminder table
// is the state, and a missed tick costs nothing - whatever is overdue is claimed next minute.
import { defineSchedule } from "eve/schedules";
import { REMINDER_TICK_CRON } from "../lib/schedule-table.js";
import { runReminderTick } from "../lib/reminder-tick.js";

export default defineSchedule({
  cron: REMINDER_TICK_CRON,
  run({ waitUntil }) {
    waitUntil(runReminderTick());
  },
});
