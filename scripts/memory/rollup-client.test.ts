/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
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
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const ROLLUP = join(ROOT, "scripts/memory/rollup.ts");
const SESSION_NAME = "rollup-session-monthly.json";

interface RecordedRequest {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
}

interface RollupRun {
  readonly code: number | null;
  /** Момент выхода процесса: остановка хода обязана случиться раньше. */
  readonly exitAt: number;
  readonly stderr: string;
  readonly stdout: string;
}

type FakeMode =
  | "own"
  | "hang"
  | "no-report"
  | "foreign"
  | "foreign-cancel-confirmed"
  | "send-disconnect"
  | "session-not-active";

function event(type: string, data?: Record<string, unknown>): object {
  return {
    ...(data ? { data } : {}),
    meta: { at: new Date().toISOString(), id: crypto.randomUUID() },
    type,
  };
}

function turn(message: string, mode: FakeMode = "own"): object[] {
  // Ход, который ещё идёт: сервер принял сообщение, конца хода нет.
  if (mode === "hang") return [event("message.received", { message })];
  // Обрыв модели: eve паркует сессию, отчёта нет.
  if (mode === "no-report")
    return [event("message.received", { message }), event("session.waiting")];
  return [
    event("message.received", { message }),
    event("message.completed", {
      finishReason: "stop",
      message: "fake monthly report",
    }),
    event("session.waiting"),
  ];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    assert.ok(typeof chunk === "string");
    body += chunk;
  }
  return body === "" ? undefined : JSON.parse(body);
}

function sendJson(
  response: import("node:http").ServerResponse,
  value: unknown,
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

class FakeEve {
  readonly requests: RecordedRequest[] = [];
  readonly server: Server;
  mode: FakeMode = "own";
  /** Сервер гасит ход не сразу после accepted, а через столько миллисекунд. */
  confirmDelayMs = 0;
  /** Ответы потока и отмены приходят с задержкой: медленный сервер. */
  streamDelayMs = 0;
  cancelDelayMs = 0;
  /** Когда сервер реально погасил ход (дописал turn.cancelled). */
  cancelledAt?: number;
  /** Файловый эффект хода: тест дописывает vault так, как это сделала бы модель. */
  onTurn?: (message: string) => void;
  #nextSession = 1;
  #events = new Map<string, object[]>();

  constructor() {
    this.server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #handle(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-eve.invalid");
    const method = request.method ?? "GET";
    const body = method === "POST" ? await readJson(request) : undefined;
    this.requests.push({
      body,
      method,
      pathname: url.pathname,
      search: url.search,
    });

    if (method === "POST" && url.pathname === "/eve/v1/session") {
      const sessionId = `wrun_fake_${this.#nextSession++}`;
      const message = this.#message(body);
      this.#events.set(sessionId, turn(message, this.mode));
      this.onTurn?.(message);
      sendJson(response, { sessionId });
      return;
    }

    const cancel = url.pathname.match(/^\/eve\/v1\/session\/([^/]+)\/cancel$/u);
    if (method === "POST" && cancel) {
      await new Promise((resolve) => setTimeout(resolve, this.cancelDelayMs));
      const cancelled = decodeURIComponent(cancel[1] ?? "");
      // Отмена идущего хода: eve дописывает конец хода, клиент его дочитывает.
      if (this.mode === "hang" && this.cancelledAt === undefined)
        setTimeout(() => {
          this.cancelledAt = Date.now();
          this.#events.set(cancelled, [
            ...(this.#events.get(cancelled) ?? []),
            event("turn.cancelled"),
            event("session.waiting"),
          ]);
        }, this.confirmDelayMs);
      sendJson(
        response,
        this.mode === "foreign-cancel-confirmed"
          ? { ok: true, status: "no_active_turn" }
          : {
              ok: true,
              sessionId: decodeURIComponent(cancel[1] ?? ""),
              status: "accepted",
            },
      );
      return;
    }

    const stream = url.pathname.match(/^\/eve\/v1\/session\/([^/]+)\/stream$/u);
    if (method === "GET" && stream) {
      await new Promise((resolve) => setTimeout(resolve, this.streamDelayMs));
      const sessionId = decodeURIComponent(stream[1] ?? "");
      const events = this.#events.get(sessionId) ?? [];
      const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-eve-stream-tail-index": String(events.length - 1),
        "x-eve-stream-version": "25",
      });
      for (const item of events.slice(startIndex)) {
        response.write(`${JSON.stringify(item)}\n`);
      }
      response.end();
      return;
    }

    const send = url.pathname.match(/^\/eve\/v1\/session\/([^/]+)$/u);
    if (method === "POST" && send) {
      const sessionId = decodeURIComponent(send[1] ?? "");
      const message = this.#message(body);
      if (this.mode === "session-not-active") {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            code: "session_not_active",
            error: "session is not active",
          }),
        );
        return;
      }
      this.#events.set(sessionId, [
        ...(this.#events.get(sessionId) ?? []),
        ...turn(
          this.mode === "foreign" || this.mode === "foreign-cancel-confirmed"
            ? "foreign rollup prompt"
            : message,
          this.mode,
        ),
      ]);
      this.onTurn?.(message);
      if (this.mode === "send-disconnect") {
        request.socket.destroy();
        return;
      }
      sendJson(response, { sessionId });
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }

  #message(body: unknown): string {
    assert.ok(body && typeof body === "object" && !Array.isArray(body));
    assert.deepEqual(Object.keys(body), ["message"]);
    const message = (body as { message?: unknown }).message;
    assert.ok(typeof message === "string");
    return message;
  }
}

function makeRunDirectory(): {
  readonly data: string;
  readonly root: string;
  readonly vault: string;
} {
  const root = mkdtempSync(join(tmpdir(), "iva-rollup-client-"));
  const data = join(root, "data");
  const vault = join(root, "vault");
  mkdirSync(data);
  mkdirSync(vault);
  return { data, root, vault };
}

interface RunOptions {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly onChild?: (child: import("node:child_process").ChildProcess) => void;
}

async function runRollup(
  host: string,
  paths: { readonly data: string; readonly vault: string },
  period = "monthly",
  { args = [], env = {}, onChild }: RunOptions = {},
): Promise<RollupRun> {
  return await new Promise<RollupRun>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [ROLLUP, period, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ASSISTANT_BEARER: "",
        ASSISTANT_DATA_DIR: paths.data,
        ASSISTANT_HOST: host,
        ASSISTANT_TIMEZONE: "UTC",
        ASSISTANT_VAULT_DIR: paths.vault,
        // eve 0.51.1 retries session_not_active after 250, 500, and 1000 ms.
        IVA_JOB_STOP_AT: String(Date.now() + 3000),
        TELEGRAM_ALLOWED_USER_IDS: "",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_DIGEST_CHAT_ID: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    onChild?.(child);
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("rollup subprocess did not exit within 5 seconds"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    let exitAt = 0;
    child.once("exit", () => {
      exitAt = Date.now();
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, exitAt, stderr, stdout });
    });
  });
}

test("production rollup creates for legacy state, then attaches, drains, and sends", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({
      createdAt: Date.now(),
      state: { sessionId: "wrun_legacy", streamIndex: 19 },
    }),
  );

  const first = await runRollup(host, paths);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fake.requests[0]?.method, "POST");
  assert.equal(fake.requests[0]?.pathname, "/eve/v1/session");
  assert.equal(
    typeof (fake.requests[0]?.body as { message?: unknown }).message,
    "string",
    "create receives create({ message }) as a string on the public wire",
  );
  const saved = JSON.parse(readFileSync(sessionFile, "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(saved).sort(), ["createdAt", "sessionId"]);
  assert.equal(saved.sessionId, "wrun_fake_1");
  assert.equal(typeof saved.createdAt, "number");

  const beforeSecond = fake.requests.length;
  const second = await runRollup(host, paths);
  assert.equal(second.code, 0, second.stderr);
  const resumed = fake.requests.slice(beforeSecond);
  assert.deepEqual(
    resumed.slice(0, 2).map(({ method, pathname }) => ({ method, pathname })),
    [
      { method: "GET", pathname: "/eve/v1/session/wrun_fake_1/stream" },
      { method: "POST", pathname: "/eve/v1/session/wrun_fake_1" },
    ],
    "attach performs a bounded drain before positional send(message)",
  );
  assert.match(
    resumed[0]?.search ?? "",
    /(?:^|[?&])includeTailIndex=1(?:&|$)/u,
  );
  assert.equal(
    typeof (resumed[1]?.body as { message?: unknown }).message,
    "string",
    "send(message) must not nest the prompt in another message object",
  );
  assert.equal(
    resumed.some(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/eve/v1/session",
    ),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(sessionFile, "utf8")), saved);
});

test("production rollup keeps the session when a foreign result cannot be cancelled", async (t) => {
  const fake = new FakeEve();
  fake.mode = "foreign";
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_existing", createdAt: Date.now() }),
  );

  const run = await runRollup(host, paths);
  assert.equal(run.code, 1, run.stderr);
  assert.equal(existsSync(sessionFile), true);
  assert.match(run.stderr, /stale stream cursor/u);
  assert.match(
    readFileSync(join(paths.data, "rollup-abandoned.jsonl"), "utf8"),
    /"reason":"stale-result-cancel-unconfirmed"/u,
  );
});

test("production rollup drops the session after confirmed cancellation of a foreign result", async (t) => {
  const fake = new FakeEve();
  fake.mode = "foreign-cancel-confirmed";
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_existing", createdAt: Date.now() }),
  );

  const run = await runRollup(host, paths);
  assert.equal(run.code, 1, run.stderr);
  assert.equal(existsSync(sessionFile), false);
  assert.match(run.stderr, /cancellation confirmed/u);
  assert.match(
    readFileSync(join(paths.data, "rollup-abandoned.jsonl"), "utf8"),
    /"reason":"stale-result"/u,
  );
});

test("a send disconnect after server acceptance blocks a fresh retry without confirmed cancellation", async (t) => {
  const fake = new FakeEve();
  fake.mode = "send-disconnect";
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  writeFileSync(
    join(paths.data, SESSION_NAME),
    JSON.stringify({ sessionId: "wrun_existing", createdAt: Date.now() }),
  );

  const run = await runRollup(host, paths);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /refusing fresh retry/u);
  assert.equal(
    fake.requests.filter(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/eve/v1/session/wrun_existing",
    ).length,
    1,
    "the server received the ambiguous send before dropping its response",
  );
  assert.equal(
    fake.requests.some(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/eve/v1/session",
    ),
    false,
    "an unconfirmed cancellation must not create a second writer",
  );
  assert.equal(
    fake.requests.some(
      ({ method, pathname }) =>
        method === "POST" &&
        pathname === "/eve/v1/session/wrun_existing/cancel",
    ),
    true,
  );
  assert.match(
    readFileSync(join(paths.data, "rollup-abandoned.jsonl"), "utf8"),
    /"reason":"cancel-unconfirmed"/u,
  );
});

test("a structured 409 session_not_active permits one fresh retry", async (t) => {
  const fake = new FakeEve();
  fake.mode = "session-not-active";
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_existing", createdAt: Date.now() }),
  );

  const run = await runRollup(host, paths);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(
    fake.requests.filter(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/eve/v1/session",
    ).length,
    1,
  );
  assert.equal(
    fake.requests.some(({ pathname }) => pathname.endsWith("/cancel")),
    false,
  );
  assert.equal(
    (JSON.parse(readFileSync(sessionFile, "utf8")) as { sessionId: string })
      .sessionId,
    "wrun_fake_1",
  );
});

test("a daily turn that hollows a section leaves the pre-turn CORE.md on disk", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const corePath = join(paths.vault, "CORE.md");
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const beforeTurn = [
    "# CORE",
    "",
    "## Предпочтения",
    "",
    "- 2026-07: отвечать коротко, без преамбул",
    "",
    "## Указатели",
    "",
    `- Последний день: summaries/daily/${yesterday} · Индекс: MOC.md`,
    "",
  ].join("\n");
  writeFileSync(corePath, beforeTurn);
  const hollowed = beforeTurn.replace(
    "- 2026-07: отвечать коротко, без преамбул",
    "",
  );
  let written = false;
  fake.onTurn = () => {
    if (written) return;
    written = true;
    writeFileSync(corePath, hollowed);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  assert.equal(written, true, "the turn must have rewritten CORE.md");
  assert.equal(readFileSync(corePath, "utf8"), beforeTurn);
});

function cancelBodies(fake: FakeEve): unknown[] {
  return fake.requests
    .filter(
      ({ method, pathname }) =>
        method === "POST" && pathname.endsWith("/cancel"),
    )
    .map(({ body }) => body);
}

function prompts(fake: FakeEve): string[] {
  return fake.requests
    .filter(
      ({ method, pathname }) =>
        method === "POST" && /^\/eve\/v1\/session(?:\/[^/]+)?$/u.test(pathname),
    )
    .map(({ body }) => (body as { message: string }).message);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const DONE_MARKER = "\n<!-- processed: 2026-09-23T04:10 -->\n";

/** Модель разбирает день из промпта и ставит отметку конца дня. */
function markDayDone(vault: string): (message: string) => void {
  return (message) => {
    const date = /daily\/(\d{4}-\d{2}-\d{2})\.md/u.exec(message)?.[1];
    assert.ok(date, "the daily prompt names the raw day it processes");
    const raw = join(vault, "daily", `${date}.md`);
    if (existsSync(raw))
      writeFileSync(raw, readFileSync(raw, "utf8") + DONE_MARKER);
  };
}

function writeRawDay(vault: string, date: string, text: string): string {
  mkdirSync(join(vault, "daily"), { recursive: true });
  const path = join(vault, "daily", `${date}.md`);
  writeFileSync(path, text);
  return path;
}

test("a turn past the job's stop time is cancelled with its tasks before the process exits", async (t) => {
  const fake = new FakeEve();
  fake.mode = "hang";
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });

  const run = await runRollup(host, paths, "monthly", {
    env: { IVA_JOB_STOP_AT: String(Date.now() + 1500) },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(cancelBodies(fake), [{ tasks: true }]);
  assert.equal(prompts(fake).length, 1, "no second writer after the stop");
  assert.doesNotMatch(run.stderr, /could not confirm/u);
});

test("SIGTERM from the runner stops the server turn the same way", async (t) => {
  const fake = new FakeEve();
  fake.mode = "hang";
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  let child: import("node:child_process").ChildProcess | undefined;
  fake.onTurn = () => {
    setTimeout(() => child?.kill("SIGTERM"), 300);
  };

  const run = await runRollup(host, paths, "monthly", {
    env: { IVA_JOB_STOP_AT: String(Date.now() + 60_000) },
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.notEqual(run.code, 0);
  assert.deepEqual(cancelBodies(fake), [{ tasks: true }]);
});

test("a model failure without a report stops the session's tasks too", async (t) => {
  const fake = new FakeEve();
  fake.mode = "no-report";
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });

  const run = await runRollup(host, paths);

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /no report/u);
  assert.deepEqual(cancelBodies(fake), [{ tasks: true }]);
});

test("a day cut mid-way resumes after its last part marker", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const yesterday = isoDaysAgo(1);
  writeRawDay(
    paths.vault,
    yesterday,
    // Скилл дописывает отметку части в конец законченного дня, после всех записей.
    "## 09:00 [text]\n\nутро\n\n## 12:05 [iva]\n\nответ\n\n" +
      "## 18:30 [text]\n\nвечер\n\n<!-- processed-through: 12:05 -->\n",
  );
  mkdirSync(join(paths.vault, "summaries", "daily"), { recursive: true });
  writeFileSync(
    join(paths.vault, "summaries", "daily", `${yesterday}.md`),
    "# part one\n",
  );
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  const sent = prompts(fake);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /after 12:05/u);
});

test("missed days are caught up oldest first in one run", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const missed = isoDaysAgo(2);
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, missed, "## 10:00 [text]\n\nпропущенный\n");
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nвчера\n");
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  const days = prompts(fake).map(
    (prompt) => /daily\/(\d{4}-\d{2}-\d{2})\.md/u.exec(prompt)?.[1],
  );
  assert.deepEqual(days, [missed, yesterday]);
});

test("the rollup takes a concrete date", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  writeRawDay(paths.vault, "2026-09-10", "## 10:00 [text]\n\nдень\n");
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily", { args: ["2026-09-10"] });

  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(
    prompts(fake).map((prompt) => prompt.includes("daily/2026-09-10.md")),
    [true],
  );
});

test("a report without the day marked done is a failed night, not a done one", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /not marked done/u);
});

/** Ход-напоминание: модель дописывает в сырой день только то, что дал тест. */
function onReminder(raw: string, tail: string): (message: string) => void {
  return (message) => {
    if (message.includes("still does not end with the processed marker"))
      writeFileSync(raw, readFileSync(raw, "utf8") + tail);
  };
}

test("a quiet day closed without the marker gets one reminder, and the marked day is done", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const raw = writeRawDay(
    paths.vault,
    isoDaysAgo(1),
    "## 22:35 [text]\n\nПривет, как дела?\n",
  );
  fake.onTurn = onReminder(raw, DONE_MARKER);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  assert.equal(prompts(fake).length, 2);
});

test("a reminder that marks only a part stops the night; the next run resumes from it", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const raw = writeRawDay(
    paths.vault,
    isoDaysAgo(1),
    "## 10:00 [text]\n\nутро\n\n## 18:00 [text]\n\nвечер\n",
  );
  fake.onTurn = onReminder(raw, "\n<!-- processed-through: 10:00 -->\n");

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.equal(prompts(fake).length, 2);
  assert.match(run.stderr, /not marked done after the turn — the next run/u);
  assert.doesNotMatch(run.stderr, /ignored the marker requirement/u);
});

test("a reminder ignored too fails the night after exactly one reminder", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const day = isoDaysAgo(1);
  writeRawDay(paths.vault, day, "## 10:00 [text]\n\nдень\n");

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.equal(prompts(fake).length, 2);
  assert.match(
    run.stderr,
    new RegExp(`${day} .*ignored the marker requirement twice`, "u"),
  );
});

test("a reminder that removes the day without a summary still fails the night", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const raw = writeRawDay(
    paths.vault,
    isoDaysAgo(1),
    "## 10:00 [text]\n\nдень\n",
  );
  fake.onTurn = (message) => {
    if (message.includes("still does not end with the processed marker"))
      rmSync(raw, { force: true });
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.equal(prompts(fake).length, 2);
});

test("a day marked done by its turn gets no reminder", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  assert.equal(prompts(fake).length, 1);
});

for (const how of ["stop time", "SIGTERM"] as const) {
  test(`on ${how} the process exits only after the server confirms the turn stopped`, async (t) => {
    const fake = new FakeEve();
    fake.mode = "hang";
    // accepted приходит сразу, а ход гаснет через 1,5 с: выход раньше — живой писатель.
    fake.confirmDelayMs = 1500;
    const host = await fake.start();
    const paths = makeRunDirectory();
    t.after(async () => {
      await fake.stop();
      rmSync(paths.root, { force: true, recursive: true });
    });
    let child: import("node:child_process").ChildProcess | undefined;
    if (how === "SIGTERM")
      fake.onTurn = () => {
        setTimeout(() => child?.kill("SIGTERM"), 300);
      };

    const run = await runRollup(host, paths, "monthly", {
      env: {
        IVA_JOB_STOP_AT: String(
          Date.now() + (how === "stop time" ? 800 : 60_000),
        ),
      },
      onChild: (spawned) => {
        child = spawned;
      },
    });

    assert.notEqual(run.code, 0);
    assert.ok(fake.cancelledAt, "the server turn was stopped");
    assert.ok(
      fake.cancelledAt <= run.exitAt,
      "the process exited before the server turn stopped",
    );
  });
}

test("SIGTERM while draining the stream before a send keeps the send from going out", async (t) => {
  const fake = new FakeEve();
  fake.mode = "hang";
  fake.streamDelayMs = 600;
  // Остановка дольше чтения потока: чтение кончится, пока процесс ещё гасит сессию.
  fake.cancelDelayMs = 1200;
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  writeFileSync(
    join(paths.data, SESSION_NAME),
    JSON.stringify({ sessionId: "wrun_saved", createdAt: Date.now() }),
  );
  let child: import("node:child_process").ChildProcess | undefined;
  setTimeout(() => child?.kill("SIGTERM"), 300);

  const run = await runRollup(host, paths, "monthly", {
    env: { IVA_JOB_STOP_AT: String(Date.now() + 60_000) },
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.notEqual(run.code, 0);
  assert.deepEqual(prompts(fake), [], "no turn may start after the stop");
});

test("a summary without the processed mark still fails the night", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nдень\n");
  // Ход написал сводку части и оборвался до отметки конца.
  fake.onTurn = () => {
    mkdirSync(join(paths.vault, "summaries", "daily"), { recursive: true });
    writeFileSync(
      join(paths.vault, "summaries", "daily", `${yesterday}.md`),
      "# part one\n",
    );
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /not marked done/u);
});

test("today and future dates are refused: only a finished day can be marked done", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  for (const date of [isoDaysAgo(0), "2099-01-01"]) {
    const run = await runRollup(host, paths, "daily", { args: [date] });
    assert.equal(run.code, 1, `${date}: ${run.stderr}`);
    assert.match(run.stderr, /not a finished day/u);
  }
  assert.deepEqual(prompts(fake), []);
});

test("an undone day leaving the catch-up window is named in the log", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const leaving = isoDaysAgo(8);
  writeRawDay(paths.vault, leaving, "## 10:00 [text]\n\nзабытый день\n");
  writeRawDay(
    paths.vault,
    isoDaysAgo(1),
    `## 10:00 [text]\n\nвчера\n${DONE_MARKER}`,
  );

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stderr,
    new RegExp(`${leaving}.*left the catch-up window`, "u"),
  );
});
