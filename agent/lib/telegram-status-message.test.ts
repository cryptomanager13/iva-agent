import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Статус живёт в run-status, а язык — в settings: оба читают ASSISTANT_DATA_DIR
// на загрузке модуля, поэтому окружение выставляем до импорта.
const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-status-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ menuStyle: "rich" }),
);
process.env.AGENT_LANGUAGE = "en";
const load = <T>(name: string): Promise<T> =>
  import(
    pathToFileURL(fileURLToPath(new URL(name, import.meta.url))).href
  ) as Promise<T>;
const status = await load<typeof import("./telegram-status-message.ts")>(
  "./telegram-status-message.ts",
);
const runStatus =
  await load<typeof import("./run-status.ts")>("./run-status.ts");

type Call = { method: string; body: Record<string, unknown> };

// Markdown из тела rich-вызова: и статус, и правки несут его в rich_message.
const markdownOf = (call: Call): string =>
  String(
    (call.body.rich_message as { markdown?: unknown } | undefined)?.markdown,
  );

// Кнопка inline в той же строке, что и loader (решение владельца 22.09.2026).
const STOP_BUTTON =
  '<tg-button type="callback_data" style="danger" data="iva_cancel">⏹</tg-button>';

function handle(
  reply: (
    call: Call,
    index: number,
  ) => { ok: boolean; body: unknown } = () => ({
    ok: true,
    body: { result: { message_id: 500 } },
  }),
) {
  const calls: Call[] = [];
  return {
    calls,
    tg: {
      chatId: "77",
      request: (method: string, body?: Record<string, unknown>) => {
        const call = { method, body: body ?? {} };
        calls.push(call);
        return Promise.resolve(reply(call, calls.length - 1));
      },
    },
  };
}

await test("статус уходит rich-сообщением с кнопкой «Стоп» в строке текста", async () => {
  const { calls, tg } = handle();

  assert.equal(await status.sendWorkingStatus(tg), 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendRichMessage");
  assert.equal(calls[0].body.disable_notification, true);
  const markdown = markdownOf(calls[0]);
  assert.equal(
    markdown,
    `<tg-emoji emoji-id="5818797194127346654">💬</tg-emoji> ${STOP_BUTTON}`,
  );
  assert.equal(markdown.includes("<tg-button-row>"), false);
  assert.equal(calls[0].body.reply_markup, undefined);
});

await test("отказ Telegram на custom_emoji роняет лоадер на ⏳ навсегда", async () => {
  const rejectCustom = handle((call, index) =>
    index === 0 && markdownOf(call).includes("tg-emoji")
      ? { ok: false, body: { description: "Bad Request: custom emoji" } }
      : { ok: true, body: { result: { message_id: 501 } } },
  );

  assert.equal(await status.sendWorkingStatus(rejectCustom.tg), 501);
  assert.equal(rejectCustom.calls.length, 2);
  assert.deepEqual(
    rejectCustom.calls.map((call) => call.body.disable_notification),
    [true, true],
  );
  // Кнопка живёт в тексте, поэтому падение анимации её не снимает.
  const fallbackMarkdown = markdownOf(rejectCustom.calls[1]);
  assert.equal(fallbackMarkdown, `⏳ ${STOP_BUTTON}`);
  assert.equal(fallbackMarkdown.includes("<tg-button-row>"), false);

  const next = handle();
  assert.equal(
    await status.sendWorkingStatus(next.tg, { canStop: false }),
    500,
  );
  assert.equal(next.calls.length, 1);
  assert.match(markdownOf(next.calls[0]), /^⏳$/u);
});

await test("вне лички кнопку «Стоп» не показываем и не дорисовываем", async () => {
  // Колбэк кнопки принимают только в личке, поэтому в группе её быть не должно:
  // нажатие всё равно вернуло бы «откройте личный чат».
  const supergroup = handle();
  const groupTg = { ...supergroup.tg, chatId: "-1001", chatType: "supergroup" };

  assert.equal(await status.sendWorkingStatus(groupTg), 500);
  assert.equal(supergroup.calls.length, 1);
  assert.equal(markdownOf(supergroup.calls[0]).includes("<tg-button"), false);

  await status.enableWorkingStatusStop(groupTg, 500);
  assert.equal(supergroup.calls.length, 1);

  // Проактивный ход приходит без типа чата — тогда решает знак chat_id.
  const proactive = handle();
  await status.sendWorkingStatus({ ...proactive.tg, chatId: "-1001" });
  await status.enableWorkingStatusStop(
    { ...proactive.tg, chatId: "-1001" },
    500,
  );
  assert.equal(proactive.calls.length, 1);
  assert.equal(markdownOf(proactive.calls[0]).includes("<tg-button"), false);

  // В личке правило прежнее: кнопка и в статусе, и в дорисовке — она часть текста,
  // поэтому кнопку дорисовывает editMessageText, а не editMessageReplyMarkup.
  const direct = handle();
  assert.equal(await status.sendWorkingStatus(direct.tg), 500);
  assert.ok(markdownOf(direct.calls[0]).endsWith(STOP_BUTTON));
  await status.enableWorkingStatusStop(direct.tg, 500);
  assert.equal(direct.calls[1].method, "editMessageText");
  assert.equal(direct.calls[1].body.message_id, 500);
  assert.ok(markdownOf(direct.calls[1]).endsWith(STOP_BUTTON));
});

await test("обычный финал гасит статус и убирает сообщение, повтор — no-op", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-1",
    statusMessageId: 500,
  });
  const { calls, tg } = handle();
  const channel = { telegram: tg };

  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["deleteMessage"],
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");

  // Позднее терминальное событие того же хода не должно трогать чужой статус.
  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    false,
  );
  assert.equal(calls.length, 1);
});

await test("отмена переписывает статус и оставляет пометку прерванного хода", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-2",
    statusMessageId: 501,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus({ telegram: tg }, "s-2", "cancelled"),
    true,
  );
  assert.equal(calls[0].method, "editMessageText");
  assert.match(markdownOf(calls[0]), /^⏹ Stopped/u);
  assert.equal(calls[0].body.text, undefined);
  assert.equal(runStatus.getChatStatus(key)?.wasCancelled, true);
});

await test("сбой Bot API на уборке не рушит терминал хода", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-3",
    statusMessageId: 502,
  });
  const failing = {
    chatId: "77",
    request: () => Promise.reject(new Error("Telegram 502")),
  };

  assert.equal(
    await status.finishTelegramStatus({ telegram: failing }, "s-3", "failed"),
    true,
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");
});

await test("чужая живая сессия не трогается поздним финишем", async () => {
  // Regression anchor from code review: a late terminal must not delete another
  // session's status message. Not a full discriminator of the current impl.
  const key = runStatus.chatKeyOf("77", undefined);
  // Живая чужая сессия — поздний terminal от старой сессии должен быть no-op.
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-live",
    statusMessageId: 777,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus(
      { telegram: tg },
      "s-old-finished",
      "completed",
    ),
    false,
  );
  assert.equal(calls.length, 0);
  const live = runStatus.getChatStatus(key);
  assert.equal(live?.status, "running");
  assert.equal(live?.sessionId, "s-live");
  assert.equal(live?.statusMessageId, 777);
});

await test("своя сессия гасит статус-сообщение", async () => {
  // Regression anchor from code review: a late terminal must not delete another
  // session's status message. Not a full discriminator of the current impl.
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-own",
    statusMessageId: 801,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus({ telegram: tg }, "s-own", "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["deleteMessage"],
  );
  assert.equal(calls[0].body.message_id, 801);
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");
});

await test("обычный статус и фолбэк rich-статуса отправляются тихо", async () => {
  const failedRich = handle((call) =>
    call.method === "sendRichMessage"
      ? { ok: false, body: { description: "rich unsupported" } }
      : { ok: true, body: { result: { message_id: 503 } } },
  );
  assert.equal(await status.sendWorkingStatus(failedRich.tg), 503);
  assert.deepEqual(
    failedRich.calls.map((call) => call.body.disable_notification),
    [true, true],
  );

  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({ menuStyle: "classic" }),
  );
  const classic = handle();
  assert.equal(await status.sendWorkingStatus(classic.tg), 500);
  assert.equal(classic.calls[0].method, "sendMessage");
  assert.equal(classic.calls[0].body.disable_notification, true);
});
