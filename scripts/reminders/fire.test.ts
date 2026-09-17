// Контракт срабатывания: в срок идёт один ход агента с текстом напоминания как промптом,
// и код отправляет его финальный текст туда, где напоминание попросили. Ход упал или
// промолчал — код шлёт текст напоминания как есть и называет причину в строке. Оба шва
// (send и ход) — двойники: сети и eve в тесте нет.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";

const root = mkdtempSync(join(tmpdir(), "iva-reminder-fire-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { add, fireDue, list } = await import("#lib/reminder-store.ts");
const { runReminderFire } = await import("./fire.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;

/** Строка уже сработала: тик перевёл её в fired и запустил ребёнка. */
async function firedRow(chat?: {
  id: string;
  threadId: string | null;
}): Promise<void> {
  await add({
    id: "r1",
    text: "позвонить в клинику",
    ...(chat === undefined ? {} : { chat }),
    schedule: { kind: "at", atMs: NOW },
  });
  await fireDue(NOW, 10);
}

type SendCall = {
  readonly bot: string;
  readonly chat: string;
  readonly text: string;
  readonly threadId?: string;
};
type SendAck = { ok: boolean; fellBack: boolean; error: string };

function makeSend(script: readonly SendAck[] = []) {
  const calls: SendCall[] = [];
  const send = (
    bot: string,
    chat: string,
    md: unknown,
    options?: { readonly threadId?: string },
  ): Promise<SendAck> => {
    calls.push({ bot, chat, text: String(md), threadId: options?.threadId });
    return Promise.resolve(
      script[calls.length - 1] ?? { ok: true, fellBack: false, error: "" },
    );
  };
  return { calls, send };
}

const turn = (status: "completed" | "failed" | "waiting", message?: string) => {
  const prompts: string[] = [];
  const runTurn = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve({
      status,
      ...(message === undefined ? {} : { message }),
      feedback: () => Promise.resolve(undefined),
    });
  };
  return { prompts, runTurn };
};

const deps = (over: Record<string, unknown> = {}) => ({
  env: {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
    ASSISTANT_BEARER: "test-bearer",
  } as NodeJS.ProcessEnv,
  chat: () => "555",
  translator: () => Promise.resolve((english: string) => english),
  log: () => {},
  ...over,
});

void test("ход выполнил напоминание: его ответ уходит в чат и тему строки", async () => {
  await firedRow({ id: "-100777", threadId: "835397" });
  const { calls, send } = makeSend();
  const { prompts, runTurn } = turn("completed", "Новости Австралии: …");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(prompts.length, 1, "ход ровно один");
  assert.match(prompts[0], /r1/u);
  assert.match(prompts[0], /позвонить в клинику/u);
  assert.match(prompts[0], /final text of this turn/u);
  assert.equal(calls.length, 1, "отправка ровно одна");
  assert.equal(calls[0].chat, "-100777");
  assert.equal(calls[0].threadId, "835397");
  assert.equal(calls[0].text, "Новости Австралии: …");
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.equal(row?.error, null);
  assert.equal(row?.status, "fired");
});

void test("строка без чата идёт в чат владельца, а waiting — нормальный конец хода", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("waiting", "напоминаю: позвонить в клинику");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat, "555");
  assert.equal(calls[0].text, "напоминаю: позвонить в клинику");
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.equal(row?.error, null);
});

void test("ход упал: код шлёт текст напоминания как есть и называет причину", async () => {
  await firedRow();
  const { calls, send } = makeSend();

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn: () => Promise.reject(new Error("no activity for 30000ms")),
      }),
    ),
    0,
  );

  assert.equal(calls.length, 1, "страховка шлёт один раз");
  assert.equal(calls[0].text, "позвонить в клинику");
  const [row] = await list();
  assert.equal(row?.delivered, true, "текст дошёл, хоть ход и упал");
  assert.match(
    String(row?.error),
    /agent turn failed: no activity for 30000ms/u,
  );
});

void test("ход вернул пустой текст: уходит текст напоминания, причина в строке", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("completed", "   ");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "позвонить в клинику");
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.match(String(row?.error), /no text/u);
});

void test("status failed: текст напоминания и причина провала хода", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { runTurn } = turn("failed", "turn timed out");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls[0].text, "позвонить в клинику");
  const [row] = await list();
  assert.match(String(row?.error), /agent turn failed: turn timed out/u);
});

void test("отправка упала: delivered=false с ответом Telegram", async () => {
  await firedRow();
  const { calls, send } = makeSend([
    { ok: false, fellBack: false, error: "400 chat not found" },
  ]);
  const { runTurn } = turn("completed", "готово: новости отправлены");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1, "повторов нет");
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.equal(row?.error, "400 chat not found");
});

void test("без токена или чата ход не запускается, а причина оседает в строке", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const { prompts, runTurn } = turn("completed", "ответ");

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn,
        env: { ASSISTANT_BEARER: "test-bearer" },
        chat: () => null,
      }),
    ),
    0,
  );

  assert.deepEqual(prompts, [], "ход не жжёт токены без адресата");
  assert.equal(calls.length, 0);
  let [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /TELEGRAM_BOT_TOKEN is missing/u);

  // Токен есть, а чата нет: строка старой схемы при пустых настройках владельца.
  assert.equal(
    await runReminderFire("r1", deps({ send, runTurn, chat: () => null })),
    0,
  );
  assert.deepEqual(prompts, []);
  assert.equal(calls.length, 0);
  [row] = await list();
  assert.match(String(row?.error), /no owner chat/u);
});

void test("вызов без id и с чужим id — отказ без записи", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  assert.equal(await runReminderFire("", deps({ send })), 2);
  assert.equal(await runReminderFire("nope", deps({ send })), 2);
  assert.equal(calls.length, 0);
  const [row] = await list();
  assert.equal(row?.delivered, null, "чужой вызов не тронул строку");
});
