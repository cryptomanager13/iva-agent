// One Reminder, judged by an eve turn and delivered by the CLI. The command keeps every
// authored-tree import lazy so repair and doctor still load on a partial installation.
import { readEnvFresh } from "../lib/env-file.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  reminderClientOptions,
  reminderPrompt,
  runReminderTurn,
} from "../lib/reminder-turn.ts";
import type { CreateClient, ReminderTurn } from "../lib/reminder-turn.ts";
import type { createCliRuntime } from "./runtime.ts";

export type {
  ReminderClientOptions,
  ReminderTurn,
} from "../lib/reminder-turn.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SendTelegramHtml =
  typeof import("../lib/telegram-send.ts").sendTelegramHtml;

type RunAgentTurn = (prompt: string) => Promise<ReminderTurn>;
type Timeout = <T>(work: Promise<T>, timeoutMs: number) => Promise<T>;

export type RemindDependencies = {
  readonly createClient?: CreateClient;
  readonly readEnv?: typeof readEnvFresh;
  readonly send?: SendTelegramHtml;
  readonly runAgentTurn?: RunAgentTurn;
  readonly timeout?: Timeout;
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const deadline: Timeout = (work, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Reminder turn timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

/** Create the remind command without reading .env or touching eve at import time. */
export function createRemindCommand(
  runtime: CliRuntime,
  dependencies: RemindDependencies = {},
) {
  const { ENV_PATH, ok } = runtime;
  const readEnv = dependencies.readEnv ?? readEnvFresh;

  return async function cmdRemind(args: readonly string[] = []): Promise<void> {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Nothing to send — usage: iva remind <text>");
    const env = await readEnv(ENV_PATH);
    const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token)
      throw new Error("TELEGRAM_BOT_TOKEN is missing — run: iva config");
    const chat = notificationChat(env);
    if (!chat)
      throw new Error(
        "No target chat — set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS in .env",
      );
    const client = reminderClientOptions(env);

    let turn: ReminderTurn | undefined;
    let failure: string | undefined;
    try {
      const { tr } = await import("#lib/i18n.ts");
      const prompt = reminderPrompt({ text }, tr);
      const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const runner =
        dependencies.runAgentTurn ??
        ((prompt) =>
          runReminderTurn(prompt, client, {
            createClient: dependencies.createClient,
          }));
      turn = await (dependencies.timeout ?? deadline)(
        runner(prompt),
        timeoutMs,
      );
    } catch (error) {
      turn = undefined;
      failure = error instanceof Error ? error.message : String(error);
    }

    const agentMessage =
      turn?.status !== "failed" && turn?.message ? turn.message : undefined;
    if (!agentMessage) {
      const cause =
        failure ??
        (turn?.status === "failed"
          ? `status "failed"${turn.message ? `: ${turn.message}` : ""}`
          : `no text (status "${turn?.status}")`);
      console.error(`remind: agent turn failed: ${cause}`);
    }
    const message = agentMessage ?? `⏰ ${text}`;
    const send =
      dependencies.send ??
      (await import("../lib/telegram-send.ts")).sendTelegramHtml;
    const result = await send(token, chat, message, { retryTransient: true });
    if (!result.ok)
      throw new Error(`Reminder Telegram send failed: ${result.error}`);
    if (agentMessage && result.fellBack && turn?.feedback) {
      // The Reminder is already delivered: a lost feedback turn must not fail the unit,
      // or the journal would claim a delivered Reminder was lost.
      try {
        await turn.feedback(
          `The last reminder failed Telegram parse_mode=HTML (${result.error}) and was sent as plain text — ` +
            "format more simply next time: **bold**, `code`, lists, no raw HTML.",
        );
      } catch {
        // Delivery succeeded; the formatting hint just will not reach this turn.
      }
    }
    ok("Reminder sent to Telegram");
  };
}
