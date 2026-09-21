// Контракт минутного тика: что забрано в fired, что ребёнок сказал сам, что тик дописал за
// него, когда пульс обновляется — и что второго захода у строки нет. Путь к данным считается
// на каждом вызове, поэтому ASSISTANT_DATA_DIR меняется до импорта модулей (образец
// reminder-store.test.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import type {
  RunScheduledJobOptions,
  RunScheduledJobResult,
} from "./schedule-runner.ts";

const root = mkdtempSync(join(tmpdir(), "iva-reminder-tick-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const {
  add,
  list,
  recordDelivery,
  recordTurnSession,
  reminderFile,
  sweepFired,
} = await import("./reminder-store.ts");
const { readTickPulse, runReminderTick, tickPulseFile } =
  await import("./reminder-tick.ts");
const { schedulerStatus } = await import("./reminder-tool.ts");
const { chatKeyOf, getChatStatus, isRunning, setChatStatus } =
  await import("./run-status.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** Просроченное разовое напоминание. */
const at = (id: string, atMs: number) =>
  add({ id, text: `напоминание ${id}`, schedule: { kind: "at", atMs } });

const ok = (): RunScheduledJobResult => ({
  skipped: false,
  ok: true,
  code: 0,
  signal: null,
});

const exited = (code: number): RunScheduledJobResult => ({
  skipped: false,
  ok: false,
  code,
  signal: null,
});

/** Ребёнка убили насмерть: своего finally он не отработал. */
const killed = (): RunScheduledJobResult => ({
  skipped: false,
  ok: false,
  code: null,
  signal: "SIGKILL",
});

/** Двойник runScheduledJob: помнит вызовы и отвечает по сценарию теста. */
function jobStub(
  handler: (
    id: string,
    options: RunScheduledJobOptions,
  ) => RunScheduledJobResult | Promise<RunScheduledJobResult>,
) {
  const calls: RunScheduledJobOptions[] = [];
  const runJob = (
    options: RunScheduledJobOptions,
  ): Promise<RunScheduledJobResult> => {
    calls.push(options);
    return Promise.resolve(handler(String(options.argv[1]), options));
  };
  return { calls, runJob };
}

function logLines() {
  const lines: string[] = [];
  const log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  return { lines, log };
}

void test("созревшая строка уходит в fired, ребёнок запускается, пульс бьётся", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const { lines, log } = logLines();
  const stub = jobStub(async (id) => {
    const [firedRow] = (await list()).filter((row) => row.id === id);
    await recordDelivery(id, {
      firedAt: firedRow?.firedAt ?? null,
      delivered: true,
      error: null,
    });
    return ok();
  });

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.deepEqual(result, { claimed: 1, spawned: 1, filled: 0, swept: 0 });
  assert.deepEqual(
    stub.calls.map((call) => [...call.argv]),
    [["scripts/reminders/fire.ts", "a"]],
  );
  // Срока у ребёнка нет: ход напоминания живёт, пока идут события (сторож тишины — внутри хода).
  assert.equal(stub.calls[0].timeoutMs, null);
  assert.equal(stub.calls[0].statusPath, undefined);

  const [row] = await list();
  assert.ok(row);
  assert.equal(row.status, "fired");
  assert.equal(row.firedAt, now);
  assert.equal(row.delivered, true);
  assert.equal(row.error, null);

  // Пульс: файл есть, mtime свежий, права закрытые.
  const pulse = readTickPulse();
  assert.ok(pulse !== null);
  assert.ok(Math.abs(pulse - Date.now()) < 60_000, "пульс не обновился");
  assert.equal(statSync(tickPulseFile()).mode & 0o777, 0o600);
  assert.ok(
    lines.some((line) => line.includes("reminders: tick claimed 1: a")),
  );
  assert.ok(
    lines.some((line) => line.includes("reminders: a fired (delivered=true)")),
  );

  // У разовой строки второго срока нет: следующий тик не будит никого.
  const second = jobStub(() => ok());
  const again = await runReminderTick({
    nowMs: now + 60_000,
    runJob: second.runJob,
    log,
  });
  assert.deepEqual(again, { claimed: 0, spawned: 0, filled: 0, swept: 0 });
  assert.equal(second.calls.length, 0);
});

void test("ребёнок не запустился: строка fired с причиной, второго захода нет", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const { lines, log } = logLines();
  const stub = jobStub(() => exited(9));

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.deepEqual(result, { claimed: 1, spawned: 0, filled: 1, swept: 0 });
  const [row] = await list();
  assert.ok(row);
  assert.equal(row.status, "fired");
  assert.equal(row.delivered, false);
  assert.match(String(row.error), /^fire process exited 9/u);
  assert.ok(lines.some((line) => line.includes("reminders: a not delivered:")));

  // Больше за эту строку не берёмся: ни сейчас, ни через час.
  const second = jobStub(() => exited(9));
  assert.deepEqual(
    await runReminderTick({ nowMs: now + 60_000, runJob: second.runJob, log }),
    { claimed: 0, spawned: 0, filled: 0, swept: 0 },
  );
  assert.deepEqual(
    await runReminderTick({
      nowMs: now + 3_600_000,
      runJob: second.runJob,
      log,
    }),
    { claimed: 0, spawned: 0, filled: 0, swept: 0 },
  );
  assert.equal(second.calls.length, 0);
});

void test("ребёнок вышел 0 без факта: это «факт не записан», а не «не дошло»", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const { lines, log } = logLines();
  // Текст мог уйти, а запись факта не состояться (лок таблицы занят): ребёнок
  // заканчивает работу успешно и молчит про таблицу.
  const stub = jobStub(() => ok());

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.deepEqual(result, { claimed: 1, spawned: 0, filled: 1, swept: 0 });
  const [row] = await list();
  assert.ok(row);
  assert.equal(row.status, "fired");
  assert.equal(
    row.delivered,
    null,
    "выход 0 без факта — не установленный провал доставки",
  );
  assert.equal(row.error, "delivery fact not recorded");
  assert.ok(
    lines.some((line) =>
      line.includes("reminders: a delivery fact not recorded"),
    ),
  );
  assert.equal(
    lines.some((line) => line.includes("not delivered")),
    false,
    "доставленное напоминание названо провалом",
  );

  // Больше за эту строку не берёмся.
  const second = jobStub(() => ok());
  assert.deepEqual(
    await runReminderTick({ nowMs: now + 60_000, runJob: second.runJob, log }),
    { claimed: 0, spawned: 0, filled: 0, swept: 0 },
  );
  assert.equal(second.calls.length, 0);
});

void test("повторяющаяся строка будит ребёнка на каждом сроке и не будит раньше", async () => {
  const now = Date.now();
  await add({
    id: "cron",
    text: "по утрам",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    nextRunAtMs: now - 60_000,
  });
  const { log } = logLines();
  const first = jobStub(async (id) => {
    const [firedRow] = (await list()).filter((row) => row.id === id);
    await recordDelivery(id, {
      firedAt: firedRow?.firedAt ?? null,
      delivered: true,
      error: null,
    });
    return ok();
  });

  await runReminderTick({ nowMs: now, runJob: first.runJob, log });
  const [row] = await list();
  assert.ok(row);
  assert.equal(row.status, "pending", "повторяющаяся ждёт следующий срок");
  assert.equal(row.delivered, true);
  assert.ok(row.nextRunAtMs > now);

  const second = jobStub(async (id) => {
    const [firedRow] = (await list()).filter((row) => row.id === id);
    await recordDelivery(id, {
      firedAt: firedRow?.firedAt ?? null,
      delivered: true,
      error: null,
    });
    return ok();
  });
  const before = await runReminderTick({
    nowMs: row.nextRunAtMs - 1,
    runJob: second.runJob,
    log,
  });
  assert.equal(before.claimed, 0, "строка сработала раньше срока");
  assert.equal(second.calls.length, 0);

  const atDeadline = await runReminderTick({
    nowMs: row.nextRunAtMs,
    runJob: second.runJob,
    log,
  });
  assert.deepEqual(atDeadline, { claimed: 1, spawned: 1, filled: 0, swept: 0 });
  assert.deepEqual(
    second.calls.map((call) => call.argv[1]),
    ["cron"],
  );
});

void test("двойник, который бросил, не роняет тик и дописывает причину", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const { lines, log } = logLines();
  const stub = jobStub(() => {
    throw new Error("spawn boom");
  });

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.deepEqual(result, { claimed: 1, spawned: 0, filled: 1, swept: 0 });
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /spawn boom/u);
  assert.ok(lines.some((line) => line.includes("not delivered")));
});

void test("битая таблица: тик не падает, пульс не обновляется", async () => {
  const now = Date.now();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(reminderFile(), "{broken");
  const { lines, log } = logLines();
  const stub = jobStub(() => ok());

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.match(String(result.error), /damaged/);
  assert.equal(result.claimed, 0);
  assert.equal(stub.calls.length, 0);
  assert.equal(readTickPulse(), null, "пульса нет: тик не подтверждён");
  assert.ok(lines.some((line) => line.includes("reminders: tick failed:")));
});

void test("сработавшие разовые строки старше суток убираются тиком", async () => {
  const now = Date.now();
  const longAgo = now - 25 * 3_600_000;
  await at("old", longAgo);
  const { log } = logLines();
  const stub = jobStub(async (id) => {
    const [firedRow] = (await list()).filter((row) => row.id === id);
    await recordDelivery(id, {
      firedAt: firedRow?.firedAt ?? null,
      delivered: true,
      error: null,
    });
    return ok();
  });

  // Строка сработала сутки с лишним назад.
  const past = await runReminderTick({
    nowMs: longAgo,
    runJob: stub.runJob,
    log,
  });
  assert.deepEqual(past, { claimed: 1, spawned: 1, filled: 0, swept: 0 });

  await at("fresh", now - 60_000);
  const today = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });
  assert.deepEqual(today, { claimed: 1, spawned: 1, filled: 0, swept: 1 });
  assert.deepEqual(
    (await list()).map((row) => row.id),
    ["fresh"],
  );
  assert.equal(await sweepFired(now), 0, "второй проход пуст");
});

void test("отметка пульса обновляется на каждом проходе и видна потребителю", async () => {
  const now = Date.now();
  const { log } = logLines();
  const stub = jobStub(() => ok());

  await runReminderTick({ nowMs: now, runJob: stub.runJob, log });
  const first = readTickPulse();
  assert.ok(first !== null);
  // Тот же пульс читает тул: без него он честно говорит, что диспетчер не бился.
  assert.equal(schedulerStatus(now, "UTC").alive, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runReminderTick({ nowMs: now + 60_000, runJob: stub.runJob, log });
  const second = readTickPulse();
  assert.ok(second !== null && second > first, "mtime пульса не сдвинулся");
});

void test("убитый ребёнок: запись хода снята тиком сразу, а не через полчаса", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const key = chatKeyOf("7701", null);
  const { log } = logLines();
  // SIGKILL: свой finally ребёнок не отработает. Сессию хода он успел записать в строку —
  // единственный признак, по которому тик находит его запись в run-status.
  const stub = jobStub(async (id) => {
    const [row] = (await list()).filter((candidate) => candidate.id === id);
    await recordTurnSession(id, {
      firedAt: row?.firedAt ?? null,
      sessionId: "sess-a",
    });
    setChatStatus(key, {
      status: "running",
      sessionId: "sess-a",
      turnId: null,
    });
    return killed();
  });

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.equal(result.filled, 1);
  assert.equal(isRunning(key), false, "чат не остаётся занятым");
  assert.equal(getChatStatus(key)?.sessionId, undefined, "сессия снята");
  const [row] = await list();
  assert.match(String(row?.error), /killed by SIGKILL/u);
});

void test("убитый ребёнок, вышедший без факта: запись хода тоже снята", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const key = chatKeyOf("7704", null);
  const { log } = logLines();
  // Текст мог уйти, а запись факта не состояться: ребёнок вышел 0 и промолчал.
  const stub = jobStub(async (id) => {
    const [row] = (await list()).filter((candidate) => candidate.id === id);
    await recordTurnSession(id, {
      firedAt: row?.firedAt ?? null,
      sessionId: "sess-a",
    });
    setChatStatus(key, {
      status: "running",
      sessionId: "sess-a",
      turnId: null,
    });
    return ok();
  });

  await runReminderTick({ nowMs: now, runJob: stub.runJob, log });

  assert.equal(isRunning(key), false, "чат не остаётся занятым");
  assert.equal(getChatStatus(key)?.sessionId, undefined, "сессия снята");
});

void test("убитый ребёнок: чужой ход в том же чате не тронут", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const key = chatKeyOf("7702", null);
  const owner = setChatStatus(key, {
    status: "running",
    sessionId: "owner-sess",
    turnId: "owner-turn",
    statusMessageId: 42,
  });
  const { log } = logLines();
  const stub = jobStub(async (id) => {
    const [row] = (await list()).filter((candidate) => candidate.id === id);
    await recordTurnSession(id, {
      firedAt: row?.firedAt ?? null,
      sessionId: "sess-a",
    });
    return killed();
  });

  await runReminderTick({ nowMs: now, runJob: stub.runJob, log });

  assert.deepEqual(getChatStatus(key), owner, "чужая запись не тронута");
  assert.equal(isRunning(key), true);
});

void test("убитый ребёнок: запись другого напоминания не тронута", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const key = chatKeyOf("7703", null);
  const other = setChatStatus(key, {
    status: "running",
    sessionId: "sess-b",
  });
  const { log } = logLines();
  const stub = jobStub(async (id) => {
    const [row] = (await list()).filter((candidate) => candidate.id === id);
    await recordTurnSession(id, {
      firedAt: row?.firedAt ?? null,
      sessionId: "sess-a",
    });
    return killed();
  });

  await runReminderTick({ nowMs: now, runJob: stub.runJob, log });

  assert.deepEqual(getChatStatus(key), other);
});
