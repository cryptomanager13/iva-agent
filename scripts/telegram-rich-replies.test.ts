// TELEGRAM_RICH_REPLIES: auto (прежнее поведение) | never (ответы в текущем чате
// всегда HTML/plain). Здесь оба пути и отказ старта на кривом значении.
/* eslint-disable @typescript-eslint/require-await -- двойник хендла повторяет асинхронную границу eve. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
  TelegramApiResponse,
  TelegramHandle,
} from "eve/channels/telegram";
import { sendThroughOutbox } from "../agent/lib/outbox.ts";
import { richRepliesMode } from "../agent/lib/telegram-rich-replies.ts";

const vault = mkdtempSync(join(tmpdir(), "iva-rich-replies-"));
const dataDir = mkdtempSync(join(tmpdir(), "iva-rich-replies-data-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = `bot-${randomUUID()}`;
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = `webhook-${randomUUID()}`;
process.env.TELEGRAM_BOT_USERNAME = "my_bot";
process.env.AGENT_LANGUAGE = "en";
// Проводка канала проверяется в режиме auto: так литерал вместо константы на вызове
// виден сразу, а сам режим живёт в одном месте файла.
process.env.TELEGRAM_RICH_REPLIES = "auto";

after(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// Разметка rich-конструкции: таблица уходит rich-сообщением, когда шов её видит.
const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

type SentBody = {
  readonly disable_notification?: boolean;
  readonly parse_mode?: string;
  readonly text?: string;
};
type ApiCall =
  | {
      readonly kind: "request";
      readonly method: string;
      readonly body: unknown;
    }
  | { readonly kind: "post"; readonly body: SentBody };

// Спецификатор в переменной — как в scripts/telegram-reply-context.test.ts. Канал один
// на файл: константа режима вычисляется при импорте, и вторая копия с другим query
// получила бы то же значение.
const telegramModule = "../agent/channels/telegram.ts?rich-replies-test";
const loadChannel = () =>
  import(telegramModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >;

// Хендл eve, каким его видит канал: ответ модели приходит событием message.completed,
// и только этот путь проверяет, что режим доехал до транспорта вместе с констант
// (agent/channels/telegram.ts).
type WiringAdapter = {
  state: Record<string, unknown>;
  createAdapterContext: (base: {
    ctx: unknown;
    session: unknown;
    state: Record<string, unknown>;
  }) => unknown;
  "message.completed": (
    data: Record<string, unknown>,
    context: unknown,
  ) => Promise<void>;
};

type WiringCall = { readonly method: string; readonly body: unknown };

// Двойник Bot API: все вызовы канала видны по имени метода, ответы успешны.
function installBotApiDouble(calls: WiringCall[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
    const requestUrl = String(url);
    const method = new URL(requestUrl).pathname.split("/").at(-1) ?? "";
    calls.push({
      method,
      body: init.body
        ? JSON.parse(
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
            String(init.body),
          )
        : undefined,
    });
    return Response.json({
      ok: true,
      result: { message_id: 1, chat: { id: 1, type: "private" } },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

// Двойник хендла eve: помнит вызовы Bot API, отвечает успехом.
function telegramDouble() {
  const calls: ApiCall[] = [];
  const tg: Pick<
    TelegramHandle,
    "chatId" | "messageThreadId" | "request" | "post"
  > = {
    chatId: "1",
    messageThreadId: undefined,
    request: async (method, body): Promise<TelegramApiResponse> => {
      calls.push({ kind: "request", method, body });
      return { ok: true, status: 200, body: {} };
    },
    post: async (body) => {
      calls.push({
        kind: "post",
        body: typeof body === "string" ? { text: body } : { ...body },
      });
      return { id: "1", raw: {} };
    },
  };
  return { calls, tg };
}

const callLine = (call: ApiCall) =>
  call.kind === "request"
    ? `request:${call.method}`
    : `post:${String(call.body.parse_mode ?? "")}`;

void test("richRepliesMode: auto по умолчанию, never по значению, мусор — ошибка с именем переменной", () => {
  assert.equal(richRepliesMode(undefined), "auto");
  assert.equal(richRepliesMode("auto"), "auto");
  assert.equal(richRepliesMode("never"), "never");

  for (const raw of ["", " ", "Never", "NEVER", "always", "false", "0"]) {
    assert.throws(
      () => richRepliesMode(raw),
      (error: Error) =>
        error.message.includes("TELEGRAM_RICH_REPLIES") &&
        error.message.includes(JSON.stringify(raw)),
      `richRepliesMode(${JSON.stringify(raw)}) обязан отказывать`,
    );
  }
});

void test("кривое TELEGRAM_RICH_REPLIES валит старт", () => {
  const run = (value: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/lib/ts-esm-hooks.ts",
        "--input-type=module",
        "--eval",
        'import("./agent/lib/telegram-rich-replies.ts")',
      ],
      {
        cwd: join(import.meta.dirname, ".."),
        encoding: "utf8",
        env: { ...process.env, TELEGRAM_RICH_REPLIES: value },
      },
    );

  const broken = run("always");
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /TELEGRAM_RICH_REPLIES/);

  // Контроль: значение из списка импортируется молча — иначе тест держит ноль.
  const allowed = run("never");
  assert.equal(allowed.status, 0, allowed.stderr);
});

void test("never: таблица уходит HTML, auto: rich", async () => {
  const { outboxTransport } = await loadChannel();

  const off = telegramDouble();
  const plainPath = outboxTransport(off.tg, "never");
  const offResult = await sendThroughOutbox(TABLE, plainPath);
  assert.equal(offResult.ok, true);
  assert.equal(offResult.delivered, 1);
  assert.equal(
    off.calls.filter((call) => call.kind === "request").length,
    0,
    "never не должен звать sendRichMessage",
  );
  assert.equal(
    off.calls.filter((call) => call.kind === "post").length,
    1,
    "never шлёт ровно один post",
  );
  assert.deepEqual(off.calls.map(callLine), ["post:HTML"]);

  // Кнопка живёт только в rich-сообщении (ADR-0015): при never ответ с <tg-button>
  // всё равно уходит sendRichMessage, иначе тег доехал бы текстом.
  const buttons = telegramDouble();
  const buttonResult = await sendThroughOutbox(
    'Поставил.\n\n<tg-button type="callback_data" data="Отмени">Отменить</tg-button> — сниму напоминание.',
    outboxTransport(buttons.tg, "never"),
  );
  assert.equal(buttonResult.ok, true);
  assert.equal(
    buttons.calls.filter((call) => call.kind === "post").length,
    0,
    "кнопка при never не должна идти HTML-путём",
  );

  const on = telegramDouble();
  const richPath = outboxTransport(on.tg, "auto");
  const onResult = await sendThroughOutbox(TABLE, richPath);
  assert.equal(onResult.ok, true);
  assert.equal(onResult.delivered, 1);
  assert.equal(
    on.calls.filter((call) => call.kind === "post").length,
    0,
    "auto не должен идти HTML-путём",
  );
  assert.equal(
    on.calls.filter((call) => call.kind === "request").length,
    1,
    "auto шлёт ровно один sendRichMessage",
  );
  assert.deepEqual(on.calls.map(callLine), ["request:sendRichMessage"]);
});

void test("тихий режим сохраняется на rich, HTML и plain-фолбэке", async () => {
  const { outboxTransport } = await loadChannel();
  const rich = telegramDouble();
  await sendThroughOutbox(TABLE, outboxTransport(rich.tg, "auto", true));
  assert.equal(rich.calls[0].kind, "request");
  assert.equal(
    (rich.calls[0].body as { disable_notification?: boolean })
      .disable_notification,
    true,
  );

  const html = telegramDouble();
  await sendThroughOutbox(
    "обычный ответ",
    outboxTransport(html.tg, "never", true),
  );
  assert.equal(html.calls[0].kind, "post");
  assert.equal(html.calls[0].body.disable_notification, true);

  const fallback = telegramDouble();
  let first = true;
  const tg = {
    ...fallback.tg,
    post: async (body: Parameters<typeof fallback.tg.post>[0]) => {
      const result = await fallback.tg.post(body);
      if (first) {
        first = false;
        throw new Error("HTML rejected");
      }
      return result;
    },
  };
  const delivered = await sendThroughOutbox(
    "обычный ответ",
    outboxTransport(tg, "never", true),
  );
  assert.equal(delivered.ok, true);
  assert.deepEqual(
    fallback.calls.map((call) =>
      call.kind === "post" ? call.body.disable_notification : undefined,
    ),
    [true, true],
  );
});

void test("канал отдаёт режим в транспорт: при auto таблица уходит rich-сообщением", async (t) => {
  const calls: WiringCall[] = [];
  t.after(installBotApiDouble(calls));

  const channel = (await loadChannel()).default;
  const adapter = (channel as unknown as { adapter: WiringAdapter }).adapter;
  const [{ ContextContainer, contextStorage }, { SessionKey }] =
    await Promise.all([
      import("../node_modules/eve/dist/src/context/container.js"),
      import("../node_modules/eve/dist/src/context/keys.js"),
    ]);

  const chatId = "77";
  const sessionId = "rich-replies-wiring";
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_0", sequence: 0 },
  });
  const context = adapter.createAdapterContext({
    ctx,
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      continuation: { token: `telegram:${chatId}::`, rekey() {} },
    },
    state: {
      ...adapter.state,
      chatId,
      chatType: "private",
      messageThreadId: null,
    },
  });

  // Таблица — та же разметка, что в тестах шва: режим решает только проводка.
  await contextStorage.run(ctx, () =>
    adapter["message.completed"](
      {
        finishReason: "stop",
        message: TABLE,
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_rich",
      },
      context,
    ),
  );

  const rendered = JSON.stringify(calls);
  assert.equal(
    calls.filter((call) => call.method === "sendRichMessage").length,
    1,
    `auto должен отдать таблицу одним sendRichMessage: ${rendered}`,
  );
  assert.equal(
    calls.filter((call) => call.method === "sendMessage").length,
    0,
    `auto не должен идти HTML-путём: ${rendered}`,
  );
  assert.equal(
    (calls[0].body as { disable_notification?: boolean }).disable_notification,
    undefined,
  );

  for (const [message, method] of [
    [`<!-- iva:silent -->\n${TABLE}`, "sendRichMessage"],
    ["<!-- iva:silent -->\nОбычный ответ", "sendMessage"],
  ]) {
    await contextStorage.run(ctx, () =>
      adapter["message.completed"](
        {
          finishReason: "stop",
          message,
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_silent",
        },
        context,
      ),
    );
    const sent = calls.at(-1);
    assert.equal(sent?.method, method);
    assert.equal(
      (sent?.body as { disable_notification?: boolean }).disable_notification,
      true,
    );
    assert.doesNotMatch(JSON.stringify(sent?.body), /iva:silent/u);
  }
});
