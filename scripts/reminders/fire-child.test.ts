// Приёмочные тесты слепого QA (qa-t17.md, блокер 3 и подтверждения), перенесённые в
// ветку как обычные тесты: настоящий отсутствующий nodeBin даёт понятную причину
// «failed to start … ENOENT» в строке; два настоящих процесса берут одну разовую
// строку ровно раз; убийство после внешнего эффекта строку не повторяет; настоящий
// ребёнок запускается без .env и доставляет текст через локальную заглушку Telegram
// (eve на этом порту нет, поэтому уходит страховка — текст напоминания как есть).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "iva-reminder-child-"));
process.env.ASSISTANT_DATA_DIR = join(TEMP_ROOT, "bootstrap");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { add, list } = await import("#lib/reminder-store.ts");
const { runReminderTick } = await import("#lib/reminder-tick.ts");
const { runScheduledJob } = await import("#lib/schedule-runner.ts");

beforeEach(() => {
  process.env.ASSISTANT_DATA_DIR = mkdtempSync(join(TEMP_ROOT, "case-"));
});
after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

const STORE_URL = new URL("../../agent/lib/reminder-store.ts", import.meta.url)
  .href;
const WORKER = `
  import { existsSync, writeFileSync } from "node:fs";
  writeFileSync(process.env.QA_READY, "ready");
  while (!existsSync(process.env.QA_GO))
    await new Promise((resolve) => setTimeout(resolve, 1));
  const { fireDue } = await import(${JSON.stringify(STORE_URL)});
  const rows = await fireDue(Number(process.env.QA_NOW), 10);
  process.stdout.write(JSON.stringify(rows.map((row) => row.id)));
`;

function worker(ready: string, go: string, now: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", WORKER],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          ASSISTANT_DATA_DIR: process.env.ASSISTANT_DATA_DIR,
          QA_READY: ready,
          QA_GO: go,
          QA_NOW: String(now),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout) as string[]);
    });
  });
}

async function waitForFiles(files: string[]): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    if (files.every(existsSync)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`workers did not reach barrier: ${files.join(", ")}`);
}

void test("two real tick processes claim a one-shot row exactly once", async () => {
  const now = 1_800_000_000_000;
  await add({
    id: "one",
    text: "один раз",
    schedule: { kind: "at", atMs: now },
  });
  const barrier = join(process.env.ASSISTANT_DATA_DIR!, "barrier");
  mkdirSync(barrier, { recursive: true });
  const readyA = join(barrier, "a");
  const readyB = join(barrier, "b");
  const go = join(barrier, "go");
  const a = worker(readyA, go, now);
  const b = worker(readyB, go, now);
  await waitForFiles([readyA, readyB]);
  writeFileSync(go, "go");
  const claimed = [...(await a), ...(await b)];
  assert.deepEqual(claimed, ["one"]);
  assert.equal((await list())[0]?.status, "fired");
});

void test("a real ENOENT child is recorded once and never relaunched", async () => {
  const now = Date.now();
  await add({
    id: "missing-child",
    text: "не повторять",
    schedule: { kind: "at", atMs: now },
  });
  const options = {
    nowMs: now,
    root: ROOT,
    nodeBin: join(process.env.ASSISTANT_DATA_DIR!, "no-such-node"),
    log: () => {},
  };
  const first = await runReminderTick(options);
  const second = await runReminderTick({ ...options, nowMs: now + 60_000 });
  assert.deepEqual(first, { claimed: 1, spawned: 0, filled: 1, swept: 0 });
  assert.deepEqual(second, { claimed: 0, spawned: 0, filled: 0, swept: 0 });
  const [row] = await list();
  assert.equal(row?.status, "fired");
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /failed to start.*ENOENT/u);
});

void test("a kill after the external side effect cannot repeat a one-shot row", async () => {
  const now = Date.now();
  await add({
    id: "killed-after-send",
    text: "ровно один раз",
    schedule: { kind: "at", atMs: now },
  });
  let externalSends = 0;
  const killed = () => {
    externalSends++;
    return Promise.resolve({
      skipped: false,
      ok: false,
      code: null,
      signal: "SIGKILL" as const,
    });
  };
  await runReminderTick({ nowMs: now, runJob: killed, log: () => {} });
  await runReminderTick({
    nowMs: now + 60_000,
    runJob: killed,
    log: () => {},
  });
  assert.equal(externalSends, 1);
  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.match(String(row?.error), /SIGKILL/u);
});

void test("the real fire child runs without .env and records a stubbed Telegram delivery", async () => {
  const now = Date.now();
  await add({
    id: "clean-child",
    text: "чистый сквозной текст",
    schedule: { kind: "at", atMs: now },
  });
  const sendLog = join(process.env.ASSISTANT_DATA_DIR!, "telegram.log");
  const preload = fileURLToPath(
    new URL("../fixtures/fake-telegram-fetch.ts", import.meta.url),
  );
  // .env в worktree сломал бы проверку: ребёнок получил бы настоящие ключи и чат.
  assert.equal(existsSync(join(ROOT, ".env")), false, "в worktree есть .env");
  const runJob = (options: Parameters<typeof runScheduledJob>[0]) =>
    runScheduledJob({
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        QA_T17_SEND_LOG: sendLog,
        ASSISTANT_DATA_DIR: process.env.ASSISTANT_DATA_DIR,
        TELEGRAM_BOT_TOKEN: "fake-token",
        TELEGRAM_DIGEST_CHAT_ID: "555",
        ASSISTANT_BEARER: "fake-bearer",
        ASSISTANT_HOST: "http://127.0.0.1:9",
        ASSISTANT_TIMEZONE: "UTC",
      },
    });
  const logs: string[] = [];
  const result = await runReminderTick({
    nowMs: now,
    root: ROOT,
    runJob,
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
  });
  assert.deepEqual(
    result,
    { claimed: 1, spawned: 1, filled: 0, swept: 0 },
    logs.join("\n"),
  );
  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.match(String(row?.error), /agent turn failed/u);
  const calls = readFileSync(sendLog, "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /чистый сквозной текст/u);
  assert.equal(dirname(sendLog), process.env.ASSISTANT_DATA_DIR);
});
