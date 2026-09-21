/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; async doubles preserve the I/O boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Сценарии long-poll живут в тестах моста (scripts/poller/control.test.ts). Здесь —
// webhook-режим, где моста нет: нажатие ловит канал и ждёт подтверждения сам.
const traceRoot = mkdtempSync(join(tmpdir(), "iva-stop-"));
process.env.ASSISTANT_DATA_DIR = join(traceRoot, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
process.on("exit", () => rmSync(traceRoot, { recursive: true, force: true }));

const { handleTelegramStopCallback, waitForTurnStop } =
  await import("./telegram-stop.ts");
type StopCancelRequest = import("./telegram-stop.ts").StopCancelRequest;
type StopStatus = import("./telegram-stop.ts").StopStatus;

const allowed = () => new Set(["42"]);
const query = {
  id: "cq-1",
  data: "iva_cancel",
  from: { id: 42 },
  message: { chat: { id: 7, type: "private" } },
};

// Запись хода под двойником: подтверждение — это изменение записи, а не ответ роута.
function statusStore(initial: StopStatus = null) {
  let value = initial;
  return {
    read: () => value,
    set: (next: StopStatus) => {
      value = next;
    },
  };
}

// Общая обвязка: копим ответы на колбэк, честные сообщения и запросы к роуту.
function tapDeps(overrides: Record<string, unknown> = {}) {
  const acks: Array<string | undefined> = [];
  const notices: string[] = [];
  const cancels: StopCancelRequest[] = [];
  return {
    acks,
    notices,
    cancels,
    deps: {
      ackImpl: async (text?: string) => {
        acks.push(text);
        return { ok: true };
      },
      notifyImpl: async (text: string) => {
        notices.push(text);
        return { ok: true };
      },
      allowedImpl: allowed,
      secret: "test-secret",
      cancelImpl: async (input: StopCancelRequest) => {
        cancels.push(input);
        return { status: "accepted" };
      },
      ...overrides,
    },
  };
}

test("a stop without the webhook secret says the turn wasn't stopped", async () => {
  const { acks, notices, cancels, deps } = tapDeps({
    secret: "",
    getStatusImpl: () => ({ status: "running", sessionId: "s-1" }),
  });

  const outcome = await handleTelegramStopCallback(query, deps);

  assert.equal(outcome, "failed");
  assert.deepEqual(acks, ["Не удалось остановить ход."]);
  // Неполный конфиг — не зависший агент: роут не трогаем и ничего не ждём.
  assert.deepEqual(cancels, []);
  assert.deepEqual(notices, []);
});

test("nothing running is answered without touching the cancel route", async () => {
  const { acks, cancels, deps } = tapDeps({ getStatusImpl: () => null });

  const outcome = await handleTelegramStopCallback(query, deps);

  assert.equal(outcome, "idle");
  assert.deepEqual(acks, ["Сейчас ничего не выполняется."]);
  assert.deepEqual(cancels, []);
});

test("an accepted stop that never confirms tells the chat honestly", async () => {
  const { acks, notices, deps } = tapDeps({
    confirmTimeoutMs: 20,
    getStatusImpl: () => ({ status: "running", sessionId: "s-2" }),
  });

  const outcome = await handleTelegramStopCallback(query, deps);

  // «Принято» — ещё не остановка: ответ на колбэк про отмену, честный текст — про факт.
  assert.equal(outcome, "requested");
  assert.deepEqual(acks, ["Останавливаю…"]);
  assert.deepEqual(notices, ["Ход не остановился за 60 с."]);
});

test("a silent cancel route is answered like a slow one and still waits", async () => {
  const { acks, notices, deps } = tapDeps({
    confirmTimeoutMs: 20,
    getStatusImpl: () => ({ status: "running", sessionId: "s-3" }),
    cancelImpl: async () => {
      throw new Error("cancel route is down");
    },
  });

  const outcome = await handleTelegramStopCallback(query, deps);

  assert.equal(outcome, "unresponsive");
  assert.deepEqual(acks, ["Останавливаю…"]);
  assert.deepEqual(notices, ["Ход не остановился за 60 с."]);
});

test("a turn that stops inside the window needs no honest text", async () => {
  const store = statusStore({ status: "running", sessionId: "s-4" });
  const { acks, notices, deps } = tapDeps({
    confirmTimeoutMs: 5000,
    getStatusImpl: store.read,
    cancelImpl: async () => {
      setTimeout(() => store.set({ status: "idle", sessionId: null }), 10);
      return { status: "accepted" };
    },
  });

  const outcome = await handleTelegramStopCallback(query, deps);

  assert.equal(outcome, "requested");
  assert.deepEqual(acks, ["Останавливаю…"]);
  assert.deepEqual(notices, []);
});

test("a tap outside a private chat only asks for a private chat", async () => {
  const { acks, cancels, deps } = tapDeps({
    getStatusImpl: () => ({ status: "running", sessionId: "s-5" }),
  });

  const outcome = await handleTelegramStopCallback(
    { ...query, message: { chat: { id: -100500, type: "supergroup" } } },
    deps,
  );

  assert.equal(outcome, "ignored");
  assert.deepEqual(acks, [
    "Открой личный чат со мной, чтобы использовать это управление.",
  ]);
  assert.deepEqual(cancels, []);
});

test("a tap from outside the allowlist is ignored", async () => {
  const { acks, cancels, deps } = tapDeps({
    allowedImpl: () => new Set(["7"]),
    getStatusImpl: () => ({ status: "running", sessionId: "s-6" }),
  });

  const outcome = await handleTelegramStopCallback(query, deps);

  assert.equal(outcome, "ignored");
  assert.deepEqual(acks, [undefined]);
  assert.deepEqual(cancels, []);
});

test("the confirmation wait sleeps the remainder of the window, not a whole step", async () => {
  let clock = 1000;
  const slept: number[] = [];

  const stopped = await waitForTurnStop("7:", "s-7", {
    getStatusImpl: () => ({ status: "running", sessionId: "s-7" }),
    timeoutMs: 1200,
    pollMs: 500,
    now: () => clock,
    sleepImpl: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
  });

  assert.equal(stopped, false);
  assert.deepEqual(slept, [500, 500, 200]);
});

test("the confirmation wait ends as soon as the record drops the session", async () => {
  const store = statusStore({ status: "running", sessionId: "s-8" });
  const slept: number[] = [];

  const stopped = await waitForTurnStop("7:", "s-8", {
    getStatusImpl: () => {
      const seen = store.read();
      store.set({ status: "idle", sessionId: null });
      return seen;
    },
    timeoutMs: 5000,
    sleepImpl: async (ms: number) => {
      slept.push(ms);
    },
  });

  assert.equal(stopped, true);
  assert.deepEqual(slept, [500]);
});
