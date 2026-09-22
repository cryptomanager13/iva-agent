/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
// Дешёвый CRAP-тест границы handleWizardCallback: шесть глаголов — что ушло в tg
// (метод + текст/клавиатура) и что записалось в состояние. Сеть и .env подменены:
// fetch пишет вызовы, состояние сеется напрямую во flows.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.ASSISTANT_DATA_DIR = mkdtempSync(join(tmpdir(), "iva-wizard-cb-"));
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

const { flows, handleWizardCallback } = (await import(
  `./wizards.ts?wizards-callback=${Date.now()}`
)) as typeof import("./wizards.ts");

type TgCall = {
  method: string;
  text: string;
  keyboard: string;
};
let seq = 0;
const nextIds = (): { chat: number; user: string } => {
  seq += 1;
  return { chat: 700 + seq, user: `42-${seq}` };
};
// ALLOWED сверяется по строковому user id: "42-1" в сете нет — чиним точечно.
const TRUSTED = "42";

function seed(step: string, extra: Record<string, unknown> = {}) {
  const { chat } = nextIds();
  const st = flows.start(chat, TRUSTED, "model") as unknown as Record<
    string,
    unknown
  >;
  st.step = step;
  st.msgId = 11;
  Object.assign(st, extra);
  return { chat, user: TRUSTED, st };
}

function tap(chat: number, user: string, data: string, messageId = 11) {
  return handleWizardCallback({
    id: "cb1",
    data,
    from: { id: 42 },
    message: { chat: { id: chat }, message_id: messageId },
  });
}

let previousFetch: typeof globalThis.fetch | undefined;
const calls: TgCall[] = [];
function spy() {
  calls.length = 0;
  previousFetch ??= globalThis.fetch;
  globalThis.fetch = (input: unknown, init?: { body?: unknown }) => {
    const url = String(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url,
    );
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as {
      text?: string;
      reply_markup?: unknown;
      rich_message?: { markdown?: string };
    };
    // Экраны визарда — rich: текст и кнопки лежат в rich_message.markdown, клавиатуры нет.
    const markdown = body.rich_message?.markdown;
    calls.push({
      method: url.split("/").at(-1) ?? "",
      text: markdown ?? body.text ?? "",
      keyboard: markdown ?? JSON.stringify(body.reply_markup ?? null),
    });
    if (url.includes("api.telegram.org"))
      return Promise.resolve(
        Response.json({ ok: true, result: { message_id: 7 } }),
      );
    // Живой каталог моделей провайдера: fetchModelOptions ждёт Response.
    return Promise.resolve(
      Response.json({ data: [{ id: "deepseek-v4-pro" }] }),
    );
  };
}

function edits(): TgCall[] {
  return calls.filter((call) => call.method === "editMessageText");
}

test("keep закрывает визард текстом и меню-клавиатурой", async () => {
  spy();
  try {
    const { chat, user, st } = seed("intro");
    assert.equal(
      await tap(chat, user, "iva_model:keep"),
      true,
      "keep обязан отработать",
    );
    assert.equal(edits().length, 1);
    assert.match(edits()[0].text, /Kept the current configuration\./u);
    assert.match(edits()[0].keyboard, /iva_menu:r:o/u);
    assert.equal(st.step, "intro");
  } finally {
    if (previousFetch) globalThis.fetch = previousFetch;
  }
});

test("cancel отвечает отменой из любого шага", async () => {
  spy();
  try {
    const { chat, user } = seed("provider");
    assert.equal(await tap(chat, user, "iva_model:cancel"), true);
    assert.equal(edits().length, 1);
    assert.match(edits()[0].text, /Cancelled\./u);
    assert.match(edits()[0].keyboard, /iva_menu:r:o/u);
  } finally {
    if (previousFetch) globalThis.fetch = previousFetch;
  }
});

test("chg рисует экран провайдеров", async () => {
  spy();
  try {
    const { chat, user, st } = seed("intro");
    assert.equal(await tap(chat, user, "iva_model:chg"), true);
    assert.equal(st.step, "provider");
    assert.equal(edits().length, 1);
    assert.match(edits()[0].text, /Pick a provider:/u);
    assert.match(edits()[0].keyboard, /iva_model:prov:ollama/u);
  } finally {
    if (previousFetch) globalThis.fetch = previousFetch;
  }
});

test("nokey у key-optional провайдера ведёт на экран моделей", async () => {
  spy();
  try {
    const { chat, user, st } = seed("awaiting_key", {
      provider: "custom",
      pendingBase: "https://custom.example.com/v1",
    });
    assert.equal(await tap(chat, user, "iva_model:nokey"), true);
    assert.equal(st.dropKey, true);
    assert.equal(st.step, "models");
    const last = edits().at(-1);
    assert.ok(last);
    assert.match(last.text, /Choose a model:/u);
  } finally {
    if (previousFetch) globalThis.fetch = previousFetch;
  }
});

test("prov: выбирает провайдера и просит ключ", async () => {
  spy();
  try {
    const { chat, user, st } = seed("provider");
    assert.equal(await tap(chat, user, "iva_model:prov:ollama"), true);
    assert.equal(st.provider, "ollama");
    assert.equal(st.step, "awaiting_key");
    const last = edits().at(-1);
    assert.ok(last);
    assert.match(last.text, /Need a .* API key\./u);
  } finally {
    if (previousFetch) globalThis.fetch = previousFetch;
  }
});

test("m: выбирает модель и рисует уровни размышлений", async () => {
  spy();
  try {
    const { chat, user, st } = seed("models", {
      provider: "ollama",
      modelOptions: [{ id: "m1", reasoningLevels: ["low"] }],
    });
    assert.equal(await tap(chat, user, "iva_model:m:0"), true);
    assert.equal(st.model, "m1");
    assert.deepEqual(st.efforts, ["low"]);
    assert.equal(st.step, "effort");
    const last = edits().at(-1);
    assert.ok(last);
    assert.match(last.text, /Thinking level for m1:/u);
  } finally {
    if (previousFetch) globalThis.fetch = previousFetch;
  }
});
