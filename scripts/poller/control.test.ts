/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; async doubles preserve the I/O boundary. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestTelegramCancel } from "#lib/telegram-cancel-client.ts";

type Event = string | [string, string, number | undefined, string | undefined];
type CaptureMessage = { message_id?: number };
type CaptureState = { flow: unknown; awaitText?: unknown };
type CancelCall = {
  url: string;
  secret: string;
  sessionId: string;
  turnId?: string;
};
type ControlUpdate = Record<string, unknown>;
type ControlModule = {
  applyTelegramButtonTap: (
    update: ControlUpdate,
    callback: Record<string, unknown>,
  ) => boolean;
  handleAwaitNonText: (
    message: CaptureMessage & Record<string, unknown>,
    pending: CaptureState,
    io: Record<string, unknown>,
  ) => Promise<boolean>;
  handleControl: (
    update: ControlUpdate,
    deps?: {
      replyImpl?: (
        chatId: number | undefined,
        text: string,
      ) => Promise<{ message_id: number } | null>;
      ackImpl?: (id: string, text?: string) => Promise<unknown>;
      cancelImpl?: (input: CancelCall) => Promise<unknown>;
      confirmTimeoutMs?: number;
      performResetImpl?: (
        chatKey: string,
        target: Record<string, unknown>,
        options: {
          clearQueue?: boolean;
          discardThroughUpdateId?: number;
        },
      ) => Promise<unknown>;
      resetRetryPendingImpl?: (chatKey: string) => boolean;
      resetIntentPendingImpl?: (chatKey: string) => boolean;
    },
  ) => Promise<boolean>;
  OUT_OF_BAND_COMMANDS: string[];
  TELEGRAM_EVE_CALLBACK_PREFIXES: readonly string[];
};
type RunStatusModule = {
  setChatStatus: (chatKey: string, patch: Record<string, unknown>) => void;
};
type QueueModule = {
  clearPrivateResetIntent: (chatKey: string) => Promise<void>;
  loadPrivateResetIntents: () => Promise<
    Array<{ chatKey: string; discardThroughUpdateId?: number }>
  >;
  performScopedReset: (
    chatKey: string,
    target: Record<string, unknown>,
    options: {
      clearQueue?: boolean;
      requestResetImpl?: () => Promise<unknown>;
      persistIntentImpl?: () => Promise<unknown>;
      retryAfterMs?: number;
    },
  ) => Promise<unknown>;
};
type MainModule = {
  handleControlSafely: (
    update: ControlUpdate,
    deps: {
      handleControlImpl: (update: ControlUpdate) => Promise<boolean>;
      logImpl: (...args: unknown[]) => void;
    },
  ) => Promise<boolean | "retry">;
};
type FlowState = Record<string, unknown>;
type WizardsModule = {
  flows: {
    start: (
      chatId: number,
      userId: string,
      flow: string,
      extra: Record<string, unknown>,
    ) => FlowState;
    get: (chatId: number, userId: string) => FlowState | null;
  };
};

// Мост читает run-status с диска и берёт allowlist из окружения на импорте, поэтому
// и то и другое ставим ДО загрузки модуля, в свежей data-директории.
const dataDir = mkdtempSync(join(tmpdir(), "iva-control-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
// Экраны моста в тестах проверяются в rich-стиле (по умолчанию у пользователя classic).
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ menuStyle: "rich" }),
);
process.env.TELEGRAM_BOT_TOKEN = "424242:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST;
delete process.env.AGENT_LANGUAGE; // без настроек язык моста — ru

const [controlModule, runStatusModule, wizardsModule, queueModule, mainModule] =
  (await Promise.all([
    import(`./control.ts?control-test=${Date.now()}`),
    import(`#lib/run-status.ts?control-test=${Date.now()}`),
    import("./wizards.ts"),
    import("./queue.ts"),
    import("./main.ts"),
  ])) as [unknown, unknown, unknown, unknown, unknown];
const {
  applyTelegramButtonTap,
  handleAwaitNonText,
  handleControl,
  OUT_OF_BAND_COMMANDS,
  TELEGRAM_EVE_CALLBACK_PREFIXES,
} = controlModule as ControlModule;
const status = runStatusModule as RunStatusModule;
const { flows } = wizardsModule as WizardsModule;
const queue = queueModule as QueueModule;
const main = mainModule as MainModule;

const CANCEL_ROUTE = "http://127.0.0.1:8723/eve/v1/telegram/cancel";
const trustedFrom = { id: 42, is_bot: false };
const chat = { id: 7, type: "private" };

function runningTurn(overrides: Record<string, unknown> = {}) {
  status.setChatStatus("7:", {
    status: "running",
    sessionId: "session-1",
    turnId: "turn-1",
    ...overrides,
  });
}

function stopButton(): ControlUpdate {
  return {
    update_id: 5,
    callback_query: {
      id: "cq-5",
      from: trustedFrom,
      message: { message_id: 4, date: 1, chat },
      data: "iva_cancel",
    },
  };
}

function stopCommand(): ControlUpdate {
  return {
    update_id: 6,
    message: {
      message_id: 6,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/stop",
    },
  };
}

test("a second /new during reset backoff is consumed without pinning offset", async () => {
  const firstReplies: string[] = [];
  const first = await handleControl(
    {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/new",
      },
    },
    {
      replyImpl: async (_chatId, text) => {
        firstReplies.push(text);
        return null;
      },
      performResetImpl: (key, target, options) =>
        queue.performScopedReset(key, target, {
          ...options,
          requestResetImpl: async () => {
            throw new Error("eve reset timed out");
          },
        }),
    },
  );
  assert.equal(first, true);
  assert.equal(firstReplies.length, 1);
  assert.equal(
    (await queue.loadPrivateResetIntents())[0]?.discardThroughUpdateId,
    7,
  );

  const secondReplies: string[] = [];
  let resetAttempts = 0;
  const second = await main.handleControlSafely(
    {
      update_id: 8,
      message: {
        message_id: 8,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/new",
      },
    },
    {
      handleControlImpl: (update) =>
        handleControl(update, {
          replyImpl: async (_chatId, text) => {
            secondReplies.push(text);
            return null;
          },
          performResetImpl: async () => {
            resetAttempts += 1;
          },
        }),
      logImpl: () => {},
    },
  );

  assert.equal(second, true);
  assert.equal(resetAttempts, 0);
  assert.equal(secondReplies.length, 1);
  assert.match(secondReplies[0] ?? "", /повтор.+запланирован/iu);
  await queue.clearPrivateResetIntent("7:");
});

test("an intent-write backoff holds the offset without another status message", async () => {
  const update = {
    update_id: 9,
    message: {
      message_id: 9,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/new",
    },
  };
  const first = await main.handleControlSafely(update, {
    handleControlImpl: (candidate) =>
      handleControl(candidate, {
        replyImpl: () => Promise.resolve(null),
        performResetImpl: (key, target, options) =>
          queue.performScopedReset(key, target, {
            ...options,
            persistIntentImpl: () => Promise.reject(new Error("disk full")),
          }),
      }),
    logImpl: () => {},
  });
  assert.equal(first, "retry");

  const secondReplies: string[] = [];
  let resetAttempts = 0;
  const second = await main.handleControlSafely(update, {
    handleControlImpl: (candidate) =>
      handleControl(candidate, {
        replyImpl: (_chatId, text) => {
          secondReplies.push(text);
          return Promise.resolve(null);
        },
        performResetImpl: () => {
          resetAttempts += 1;
          return Promise.resolve();
        },
      }),
    logImpl: () => {},
  });

  assert.equal(second, "retry");
  assert.equal(resetAttempts, 0);
  assert.deepEqual(secondReplies, []);
  await queue.clearPrivateResetIntent("7:");
});

test("persistent intent-write failure escalates and releases the global offset", async () => {
  const update = {
    update_id: 10,
    message: {
      message_id: 10,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/new",
    },
  };
  const results: Array<boolean | "retry"> = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    results.push(
      await main.handleControlSafely(update, {
        handleControlImpl: (candidate) =>
          handleControl(candidate, {
            replyImpl: () => Promise.resolve(null),
            performResetImpl: (key, target, options) =>
              queue.performScopedReset(key, target, {
                ...options,
                persistIntentImpl: () =>
                  Promise.reject(new Error("disk remains read-only")),
                retryAfterMs: 0,
              }),
          }),
        logImpl: () => {},
      }),
    );
  }

  assert.deepEqual(results.slice(0, 9), Array(9).fill("retry"));
  assert.equal(results[9], true);
  await queue.clearPrivateResetIntent("7:");
});

function recordingDeps() {
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const replies: Array<[number | undefined, string]> = [];
  return {
    cancels,
    acks,
    replies,
    deps: {
      // Двойник успешного пути: eve принял отмену, а терминальное turn.cancelled
      // переписал запись — то есть ход действительно остановился.
      cancelImpl: async (input: CancelCall) => {
        cancels.push(input);
        stopTurn("7:");
        return { ok: true, status: "accepted" };
      },
      ackImpl: async (id: string, text?: string) => {
        acks.push([id, text]);
        return { ok: true, result: true };
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: replies.length };
      },
    },
  };
}

test("secret document capture deletes before download and never reaches Eve", async () => {
  const events: Event[] = [];
  const io = {
    deleteSecret: async () => {
      events.push("delete");
      return true;
    },
    download: async () => {
      events.push("download");
      return "client secret";
    },
    deliver: async (
      text: string,
      message: CaptureMessage,
      state: CaptureState,
    ) => {
      events.push([
        "deliver",
        text,
        message.message_id,
        (state.awaitText as { kind?: string } | undefined)?.kind,
      ]);
    },
    reply: async () => assert.fail("must not reply after a successful capture"),
  };

  const consumed = await handleAwaitNonText(
    {
      message_id: 7,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    io,
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, [
    "delete",
    "download",
    ["deliver", "client secret", 7, "gws_client_secret"],
  ]);
});

test("failed deletion consumes a secret document without downloading it", async () => {
  const events: Event[] = [];
  const consumed = await handleAwaitNonText(
    {
      message_id: 8,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    {
      deleteSecret: async () => {
        events.push("delete");
        return false;
      },
      download: async () => assert.fail("must not download a visible secret"),
      deliver: async () => assert.fail("must not deliver a visible secret"),
      reply: async () => assert.fail("deleteSecret owns the failure warning"),
    },
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, ["delete"]);
});

test("the ⏹ Stop button cancels through the channel route, never through Eve", async () => {
  runningTurn();
  const { cancels, acks, replies, deps } = recordingDeps();

  const consumed = await handleControl(stopButton(), deps);

  assert.equal(consumed, true); // тап съеден мостом и в eve не уходит
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-1",
      turnId: "turn-1",
    },
  ]);
  assert.deepEqual(acks, [["cq-5", "Останавливаю…"]]);
  assert.deepEqual(replies, []);
});

test("/stop takes the same door and stays silent while the status message speaks", async () => {
  runningTurn({ sessionId: "session-2", turnId: "turn-2" });
  const { cancels, replies, deps } = recordingDeps();

  const consumed = await handleControl(stopCommand(), deps);

  assert.equal(consumed, true);
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-2",
      turnId: "turn-2",
    },
  ]);
  // Подтверждение — переписанное «Работаю…», а не второе сообщение в чате.
  assert.deepEqual(replies, []);
});

test("Stop on an idle chat explains itself and never calls cancel", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });
  const { cancels, acks, replies, deps } = recordingDeps();

  assert.equal(await handleControl(stopButton(), deps), true);
  assert.equal(await handleControl(stopCommand(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", "Сейчас ничего не выполняется."]]);
  assert.deepEqual(replies, [[7, "Сейчас ничего не выполняется."]]);
});

test("an early running status without a session is not cancellable", async () => {
  status.setChatStatus("7:", {
    status: "running",
    sessionId: null,
    turnId: null,
    ingressId: "ingress-1",
  });
  const { cancels, acks, deps } = recordingDeps();

  assert.equal(await handleControl(stopButton(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", "Сейчас ничего не выполняется."]]);
});

test("an untrusted tap on someone else's Stop button is swallowed", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();
  const update = stopButton();
  (update.callback_query as Record<string, unknown>).from = {
    id: 999,
    is_bot: false,
  };

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(cancels, []);
  // Спиннер кнопки гасим, но ход чужого пользователя не трогаем и ничего не объясняем.
  assert.deepEqual(acks, [["cq-5", undefined]]);
});

// Терминальное событие отмены глазами моста: такую запись оставляет turn.cancelled.
function stopTurn(key: string) {
  status.setChatStatus(key, {
    status: "idle",
    sessionId: null,
    turnId: null,
    wasCancelled: true,
  });
}

// Состарить запись run-status, не трогая её раскладку: правим ровно одно поле.
// Иначе тест «Стоп» после краша не отличить от свежего хода.
function backdateRunStatus(sessionId: string, ageMs: number) {
  const dir = join(dataDir, "run-status.d");
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      sessionId?: string;
      updatedAt?: number;
    };
    if (parsed.sessionId !== sessionId) continue;
    writeFileSync(
      file,
      JSON.stringify({ ...parsed, updatedAt: Date.now() - ageMs }),
    );
    return;
  }
  throw new Error(`run-status record for ${sessionId} not found`);
}

// Двойник молчащего cancel-роута: запрос уходит, ответа нет — так выглядит зависший
// агент. Таймаут клиента уважаем (сигнал обрывает ожидание), иначе тест повис бы навсегда.
function silentRouteCancel(timeoutMs: number, calls: CancelCall[] = []) {
  return async (input: CancelCall) => {
    calls.push(input);
    return requestTelegramCancel({
      ...input,
      timeoutMs,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () =>
            reject(
              init.signal?.reason instanceof Error
                ? init.signal.reason
                : new Error("cancel route timed out"),
            );
          if (init.signal?.aborted === true) abort();
          else init.signal?.addEventListener("abort", abort);
        }),
    });
  };
}

test("a stale run record still reaches the cancel route while it remembers the session", async () => {
  runningTurn();
  backdateRunStatus("session-1", 31 * 60_000);
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const consumed = await handleControl(stopButton(), {
    cancelImpl: async (input: CancelCall) => {
      cancels.push(input);
      stopTurn("7:");
      return { ok: true, status: "accepted" };
    },
    ackImpl: async (id: string, text?: string) => {
      acks.push([id, text]);
      return { ok: true, result: true };
    },
  });

  assert.equal(consumed, true);
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-1",
      turnId: "turn-1",
    },
  ]);
  assert.deepEqual(acks, [["cq-5", "Останавливаю…"]]);
});

test("a stale run record whose turn is already gone ends as idle", async () => {
  runningTurn();
  backdateRunStatus("session-1", 31 * 60_000);
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const consumed = await handleControl(stopButton(), {
    cancelImpl: async (input: CancelCall) => {
      cancels.push(input);
      return { ok: true, status: "no_active_turn" };
    },
    ackImpl: async (id: string, text?: string) => {
      acks.push([id, text]);
      return { ok: true, result: true };
    },
  });

  assert.equal(consumed, true);
  assert.equal(cancels.length, 1);
  assert.deepEqual(acks, [["cq-5", "Сейчас ничего не выполняется."]]);
});

test("a silent cancel route restarts the service in the owner's private chat", async () => {
  runningTurn();
  await withFakeSystemctl(0, async (argsLog) => {
    const cancels: CancelCall[] = [];
    const resets: ResetCall[] = [];
    const acks: Array<[string, string | undefined]> = [];
    const replies: Array<[number | undefined, string]> = [];
    const consumed = await handleControl(stopButton(), {
      cancelImpl: silentRouteCancel(20, cancels),
      performResetImpl: async (key, target, options) => {
        resets.push([key, target, options]);
      },
      ackImpl: async (id: string, text?: string) => {
        acks.push([id, text]);
        return { ok: true, result: true };
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: 1 };
      },
    });

    assert.equal(consumed, true);
    assert.equal(cancels.length, 1);
    assert.equal(readFileSync(argsLog, "utf8"), "--user restart iva.service\n");
    assert.deepEqual(resets, [
      [
        "7:",
        { sessionId: "session-1" },
        { clearQueue: true, discardThroughUpdateId: 5 },
      ],
    ]);
    assert.deepEqual(replies, [[7, "Ива не отвечала — сервис перезапущен."]]);
    assert.deepEqual(acks, [["cq-5", "Ива не отвечала — сервис перезапущен."]]);
  });
});

test("a silent cancel route in a group never restarts the service", async () => {
  status.setChatStatus("-100500:", {
    status: "running",
    sessionId: "group-session",
    turnId: "turn-group",
  });
  await withFakeSystemctl(0, async (argsLog) => {
    const resets: ResetCall[] = [];
    const replies: Array<[number | undefined, string]> = [];
    const consumed = await handleControl(
      {
        update_id: 6,
        message: {
          message_id: 6,
          date: 1,
          chat: { id: -100500, type: "group" },
          from: trustedFrom,
          text: "/stop",
        },
      },
      {
        cancelImpl: silentRouteCancel(20),
        performResetImpl: async (key, target, options) => {
          resets.push([key, target, options]);
        },
        replyImpl: async (chatId: number | undefined, text: string) => {
          replies.push([chatId, text]);
          return { message_id: 1 };
        },
      },
    );

    assert.equal(consumed, true);
    assert.equal(systemctlCalls(argsLog), "");
    assert.deepEqual(resets, []);
    assert.deepEqual(replies, [
      [-100500, "Ива не отвечает — остановить ход не удалось."],
    ]);
  });
});

test("an accepted cancel without a terminal event escalates like a silent route", async () => {
  runningTurn({ sessionId: "session-2" });
  await withFakeSystemctl(0, async (argsLog) => {
    const resets: ResetCall[] = [];
    const replies: Array<[number | undefined, string]> = [];
    const consumed = await handleControl(stopButton(), {
      cancelImpl: async () => ({ ok: true, status: "accepted" }),
      confirmTimeoutMs: 30,
      performResetImpl: async (key, target, options) => {
        resets.push([key, target, options]);
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: 1 };
      },
      ackImpl: async () => ({ ok: true, result: true }),
    });

    assert.equal(consumed, true);
    assert.equal(readFileSync(argsLog, "utf8"), "--user restart iva.service\n");
    assert.equal(resets.length, 1);
    assert.match(replies[0]?.[1] ?? "", /перезапущ/u);
  });
});

test("a failed escalation explains itself and never claims a restart", async () => {
  runningTurn({ sessionId: "session-3" });
  // Рестарт не удался: текст не имеет права обещать перезапуск.
  await withFakeSystemctl(1, async (argsLog) => {
    const replies: Array<[number | undefined, string]> = [];
    const consumed = await handleControl(stopButton(), {
      cancelImpl: async () => ({ ok: true, status: "accepted" }),
      confirmTimeoutMs: 30,
      performResetImpl: async () => {
        throw new Error("reset route is down");
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: 1 };
      },
      ackImpl: async () => ({ ok: true, result: true }),
    });

    assert.equal(consumed, true);
    // Неудачный сброс не отменяет попытку рестарта: именно он и лечит зависший процесс.
    assert.equal(systemctlCalls(argsLog), "--user restart iva.service\n");
    assert.deepEqual(replies, [
      [7, "Ива не отвечает — остановить ход не удалось."],
    ]);
  });
});

test("a stop right after an escalation does not restart the service twice", async () => {
  runningTurn({ sessionId: "session-4" });
  await withFakeSystemctl(0, async (argsLog) => {
    const resets: ResetCall[] = [];
    const replies: Array<[number | undefined, string]> = [];
    const deps = {
      // Роут принимает отмену, но ход не заканчивается: мост ждёт подтверждения впустую.
      cancelImpl: async () => ({ ok: true, status: "accepted" }),
      confirmTimeoutMs: 30,
      performResetImpl: async (
        key: string,
        target: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        resets.push([key, target, options]);
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: 1 };
      },
      ackImpl: async () => ({ ok: true, result: true }),
    };

    for (let tap = 0; tap < 3; tap++) {
      assert.equal(await handleControl(stopButton(), deps), true);
    }

    assert.equal(readFileSync(argsLog, "utf8"), "--user restart iva.service\n");
    assert.equal(resets.length, 1);
    assert.equal(replies.length, 1);
  });
});

test("repeated Stop taps during one escalation restart the service once", async () => {
  runningTurn({ sessionId: "session-5" });
  await withFakeSystemctl(0, async (argsLog) => {
    const resets: ResetCall[] = [];
    const replies: Array<[number | undefined, string]> = [];
    const deps = {
      cancelImpl: async () => ({ ok: true, status: "accepted" }),
      confirmTimeoutMs: 30,
      performResetImpl: async (
        key: string,
        target: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        resets.push([key, target, options]);
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: 1 };
      },
      ackImpl: async () => ({ ok: true, result: true }),
    };

    const outcomes = await Promise.all([
      handleControl(stopButton(), deps),
      handleControl(stopButton(), deps),
      handleControl(stopButton(), deps),
    ]);

    assert.deepEqual(outcomes, [true, true, true]);
    assert.equal(readFileSync(argsLog, "utf8"), "--user restart iva.service\n");
    assert.equal(resets.length, 1);
    assert.equal(replies.length, 1);
  });
});

test("repeated taps after the turn is gone stay harmless", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();

  await handleControl(stopButton(), deps);
  status.setChatStatus("7:", { status: "idle", sessionId: null, turnId: null });
  await handleControl(stopButton(), deps);
  await handleControl(stopButton(), deps);

  assert.equal(cancels.length, 1);
  assert.deepEqual(acks.slice(1), [
    ["cq-5", "Сейчас ничего не выполняется."],
    ["cq-5", "Сейчас ничего не выполняется."],
  ]);
});

test("/start is answered by the bridge and never becomes a model turn", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], 7);
  assert.match(replies[0][1], /Iva/u);
  assert.match(replies[0][1], /\/help/u);
  assert.match(replies[0][1], /\/menu/u);
  assert.ok(OUT_OF_BAND_COMMANDS.includes("/start"));
});

test("/start from an untrusted user is not answered by the bridge", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 8,
      message: {
        message_id: 8,
        date: 1,
        chat,
        from: { id: 999, is_bot: false },
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, false); // дальше его молча уронит allowlist входного пайплайна
  assert.deepEqual(replies, []);
});

test("non-private group-safe commands leave stale pending flows unchanged", async () => {
  const previousFetch = globalThis.fetch;
  const botApiMethods: string[] = [];
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    botApiMethods.push(url.split("/").at(-1) ?? "");
    return Response.json({ ok: true, result: { message_id: 99 } });
  };
  try {
    for (const chatType of ["group", "supergroup", "channel", undefined]) {
      const state = flows.start(7, "42", "menu", {
        screen: "srch",
        msgId: 701,
        awaitText: {
          kind: "apikey",
          secret: true,
          data: { provider: "synthetic" },
        },
      });
      const before = structuredClone(state);
      const { replies, deps } = recordingDeps();

      const consumed = await handleControl(
        {
          update_id: 701,
          message: {
            message_id: 701,
            date: 1,
            chat: { id: 7, type: chatType },
            from: trustedFrom,
            text: "/help",
          },
        },
        deps,
      );

      assert.equal(consumed, true, String(chatType));
      assert.deepEqual(flows.get(7, "42"), before, String(chatType));
      assert.equal(replies.length, 1, String(chatType));
    }
    assert.deepEqual(botApiMethods, []);
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

test("settings commands reject every non-private chat before state or Bot API effects", async () => {
  const previousFetch = globalThis.fetch;
  const botApiMethods: string[] = [];
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    botApiMethods.push(url.split("/").at(-1) ?? "");
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 99 } }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    for (const command of ["/menu", "/model", "/think"]) {
      for (const chatType of ["group", "supergroup", "channel", undefined]) {
        const { replies, deps } = recordingDeps();
        const consumed = await handleControl(
          {
            update_id: 800,
            message: {
              message_id: 800,
              date: 1,
              chat: { id: -800, type: chatType },
              from: trustedFrom,
              text: command,
            },
          },
          deps,
        );

        assert.equal(consumed, true, `${command}:${String(chatType)}`);
        assert.equal(replies.length, 1, `${command}:${String(chatType)}`);
        assert.match(
          replies[0][1],
          /private|личн/u,
          `${command}:${String(chatType)}`,
        );
      }
    }
    assert.deepEqual(botApiMethods, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local callbacks reject non-private chats before cancellation or dispatch", async () => {
  for (const data of [
    "iva_cancel",
    "iva_update:do",
    "iva_model:keep",
    "iva_think:keep",
    "iva_menu:r:o",
  ]) {
    for (const chatType of ["group", "supergroup", "channel", undefined]) {
      runningTurn();
      const { cancels, acks, deps } = recordingDeps();
      const update = stopButton();
      const callback = update.callback_query as Record<string, unknown>;
      callback.data = data;
      callback.message = {
        message_id: 4,
        date: 1,
        chat: { id: 7, type: chatType },
      };

      const label = `${data}:${String(chatType)}`;
      assert.equal(await handleControl(update, deps), true, label);
      assert.deepEqual(cancels, [], label);
      assert.equal(acks.length, 1, label);
      assert.match(acks[0][1] ?? "", /private|личн/u, label);
    }
  }
});

test("a non-private rejection does not reveal controls to an untrusted user", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();
  const update = stopButton();
  const callback = update.callback_query as Record<string, unknown>;
  callback.from = { id: 999, is_bot: false };
  callback.message = {
    message_id: 4,
    date: 1,
    chat: { id: 7, type: "group" },
  };

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", undefined]]);
});

// Кнопка, написанная моделью: её data — реплика пользователя, поэтому тап уходит
// дальше обычным сообщением (allowlist, очередь и доставка — как у текста), а не
// колбэком в eve: сессию наполняет inbound pipeline, а он читает сообщения.
test("тап по кнопке модели уходит дальше обычным сообщением", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 61,
    callback_query: {
      id: "cq-tap",
      from: trustedFrom,
      data: "Отложи на час",
      message: {
        message_id: 77,
        date: 1_700_000_000,
        message_thread_id: 5,
        chat,
        from: { id: 424242, is_bot: true },
        text: "Напомнить?",
      },
    },
  };

  assert.equal(
    await handleControl(update, deps),
    false,
    "тап идёт в admission",
  );
  assert.deepEqual(acks, [["cq-tap", undefined]]);
  assert.equal(update.callback_query, undefined, "колбэк больше не колбэк");
  assert.deepEqual(update.message, {
    message_id: 77,
    date: 1_700_000_000,
    message_thread_id: 5,
    chat,
    from: { id: 42, is_bot: false },
    text: "Отложи на час",
  });
});

// Отправителя — нажавшего, не бота, и чат — тот же, где стоит кнопка: иначе ответ
// уедет в чужой чат, а allowlist будет судить чат-бота.
test("тап отвечает от нажавшего и в чат кнопки, а не в чат бота", async () => {
  const update: ControlUpdate = {
    update_id: 62,
    callback_query: {
      id: "cq-sender",
      from: { id: 42, is_bot: false, username: "owner" },
      data: "Да",
      message: {
        message_id: 78,
        chat: { id: 7, type: "private", title: "bot chat" },
        from: { id: 424242, is_bot: true },
      },
    },
  };

  assert.equal(
    applyTelegramButtonTap(update, update.callback_query as never),
    true,
  );
  const tap = update.message as Record<string, unknown>;
  assert.deepEqual(tap.from, { id: 42, is_bot: false, username: "owner" });
  assert.deepEqual(tap.chat, { id: 7, type: "private", title: "bot chat" });
});

// eve владеет двумя префиксами: подтверждения HITL и кнопки входа в подключения.
// Подмена их сообщением молча теряет подтверждение или вход, поэтому они уходят в eve.
test("колбэки eve мост не подменяет сообщением", async () => {
  const eve = (await import("eve/channels/telegram")) as {
    TELEGRAM_HITL_CALLBACK_PREFIX: string;
  };
  assert.equal(
    TELEGRAM_EVE_CALLBACK_PREFIXES[0],
    eve.TELEGRAM_HITL_CALLBACK_PREFIX,
    "префикс HITL-колбэка обязан совпадать с eve",
  );

  for (const data of ["eve:1", "eve_auth:42"]) {
    const { acks, deps } = recordingDeps();
    const update: ControlUpdate = {
      update_id: 63,
      callback_query: {
        id: `cq-${data}`,
        from: trustedFrom,
        message: { message_id: 1, date: 1, chat },
        data,
      },
    };

    assert.equal(await handleControl(update, deps), false, data);
    assert.equal(update.message, undefined, data);
    assert.ok(update.callback_query, data);
    assert.deepEqual(acks, [], data);
  }
});

// Пространство `iva_*` — моста: незнакомый его колбэк остаётся колбэком (сегодня его
// доставляет eve), в сообщение его не превращаем даже когда экрана для него ещё нет.
test("незнакомый iva-колбэк остаётся в пространстве моста", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 64,
    callback_query: {
      id: "cq-iva-future",
      from: trustedFrom,
      message: { message_id: 1, date: 1, chat },
      data: "iva_future:x",
    },
  };

  assert.equal(await handleControl(update, deps), false);
  assert.equal(update.message, undefined);
  assert.deepEqual(acks, []);
});

// Чужому тапу — пустой ack без подсказок (наличие контрола знать нечего), а решение
// по allowlist остаётся за admission: он же пишет отброс в журнал.
test("чужой тап гасит спиннер и не становится сообщением", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 65,
    callback_query: {
      id: "cq-stranger",
      from: { id: 999, is_bot: false },
      message: { message_id: 1, date: 1, chat },
      data: "Отложи на час",
    },
  };

  assert.equal(await handleControl(update, deps), false);
  assert.deepEqual(acks, [["cq-stranger", undefined]]);
  assert.equal(update.message, undefined);
  assert.ok(update.callback_query, "allowlist судит admission, а не мост");
});

// В группе текст принимается только как упоминание, команда или reply боту, а нажатие
// кнопки — ни то, ни другое: тап там не доедет, поэтому говорим про личку прямо.
test("тап в группе отвечает подсказкой про личный чат", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 66,
    callback_query: {
      id: "cq-group-tap",
      from: trustedFrom,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -1001, type: "supergroup" },
      },
      data: "Отложи на час",
    },
  };

  assert.equal(await handleControl(update, deps), true, "тап проглочен");
  assert.equal(acks.length, 1);
  assert.match(acks[0][1] ?? "", /private|личн/u);
  assert.equal(update.message, undefined);
  assert.ok(update.callback_query, "подсказка — не доставка");
});

// Конверт без сообщения (inline_message_id) или без чата сообщением стать не может —
// гасим тап здесь, иначе admission запишет его и очередь встанет на повторе.
test("неполный конверт тапа не превращается в сообщение", async () => {
  for (const callback of [
    { id: "cq-inline", from: trustedFrom, data: "Да" },
    {
      id: "cq-no-chat",
      from: trustedFrom,
      data: "Да",
      message: { message_id: 1, date: 1 },
    },
  ]) {
    const { acks, deps } = recordingDeps();
    const update: ControlUpdate = { update_id: 67, callback_query: callback };
    const label = String(callback.id);

    assert.equal(await handleControl(update, deps), true, label);
    assert.deepEqual(acks, [[String(callback.id), undefined]], label);
    assert.equal(update.message, undefined, label);
    assert.ok(update.callback_query, label);
  }
});

// Тап без отправителя — не наш: allowlist судит admission по from, а его нет.
test("тап без отправителя не подменяется, его снимает admission", async () => {
  const { acks, deps } = recordingDeps();
  const update: ControlUpdate = {
    update_id: 68,
    callback_query: {
      id: "cq-no-from",
      data: "Да",
      message: { message_id: 1, date: 1, chat },
    },
  };

  assert.equal(await handleControl(update, deps), false);
  assert.deepEqual(acks, [["cq-no-from", undefined]]);
  assert.equal(update.message, undefined);
  assert.ok(update.callback_query);
});

test("malformed update callback is not claimed as a local control", async () => {
  const methods: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    methods.push(url.split("/").at(-1) ?? "");
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const consumed = await handleControl({
      update_id: 9,
      callback_query: {
        id: "cq-invalid-update",
        from: trustedFrom,
        message: { message_id: 9, date: 1, chat },
        data: "iva_update:do-now",
      },
    });

    assert.equal(consumed, false);
    assert.deepEqual(methods, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a falsey local reply does not authorize offset acknowledgement", async () => {
  const consumed = await handleControl(
    {
      update_id: 10,
      message: {
        message_id: 10,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/help",
      },
    },
    { replyImpl: async () => null },
  );

  assert.equal(consumed, false);
});

test("a falsey callback ack does not claim a local control", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });

  const consumed = await handleControl(stopButton(), {
    ackImpl: async () => null,
  });

  assert.equal(consumed, false);
});

test("a false callback ack result does not claim a local control", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });

  const consumed = await handleControl(stopButton(), {
    ackImpl: async () => ({ ok: true, result: false }),
  });

  assert.equal(consumed, false);
});

for (const [command, updateId] of [
  ["/model", 21],
  ["/think", 22],
] as const) {
  test(`${command} is retained when its initial Bot API screen fails`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, result: false }), {
        headers: { "content-type": "application/json" },
      });
    try {
      const consumed = await handleControl({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat,
          from: trustedFrom,
          text: command,
        },
      });

      assert.equal(consumed, false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test("model keep callback is retained when only spinner ack succeeds", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), {
      headers: { "content-type": "application/json" },
    });
  try {
    assert.equal(
      await handleControl({
        update_id: 11,
        message: {
          message_id: 11,
          date: 1,
          chat: { id: 71, type: "private" },
          from: trustedFrom,
          text: "/model",
        },
      }),
      true,
    );

    const methods: string[] = [];
    globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      methods.push(url.split("/").at(-1) ?? "");
      return new Response(
        JSON.stringify(
          url.endsWith("/answerCallbackQuery")
            ? { ok: true, result: true }
            : { ok: false, result: false },
        ),
        { headers: { "content-type": "application/json" } },
      );
    };

    const callback = {
      update_id: 12,
      callback_query: {
        id: "cq-model-keep",
        from: trustedFrom,
        message: {
          message_id: 71,
          date: 1,
          chat: { id: 71, type: "private" },
        },
        data: "iva_model:keep",
      },
    };
    const consumed = await handleControl(callback);

    assert.equal(consumed, false);
    // Терминальный экран визарда — rich-сообщение: новый экран уходит sendRichMessage'ом.
    assert.deepEqual(methods, [
      "answerCallbackQuery",
      "editMessageText",
      "sendRichMessage",
    ]);

    globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      methods.push(url.split("/").at(-1) ?? "");
      return new Response(
        JSON.stringify(
          url.endsWith("/answerCallbackQuery")
            ? { ok: true, result: true }
            : { ok: true, result: { message_id: 71 } },
        ),
        { headers: { "content-type": "application/json" } },
      );
    };

    assert.equal(await handleControl(callback), true);
    assert.deepEqual(methods.slice(3), [
      "answerCallbackQuery",
      "editMessageText",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// Тап по кнопке мёртвого экрана в СТАРОМ сообщении не забирает у живого меню ни его
// сообщение, ни ожидание ввода. Иначе ожидание переезжает в корень, где обрабатывать
// его kind нечем, и следующий ОБЫЧНЫЙ текст пользователя мост удаляет как креденшл
// вместо доставки в eve.
test("a dead menu tap leaves the live menu's pending input alone", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const raw = init?.body;
    calls.push({
      method: url.split("/").at(-1) ?? "",
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    return Response.json({ ok: true, result: { message_id: 100 } });
  };
  try {
    const live = flows.start(7, "42", "menu", {
      screen: "srch",
      page: 0,
      msgId: 100,
      awaitText: { kind: "apikey", secret: true, data: { provider: "tavily" } },
    });

    const tapped = await handleControl(
      {
        update_id: 910,
        callback_query: {
          id: "cq-dead-menu",
          from: trustedFrom,
          message: { message_id: 55, date: 1, chat },
          data: "iva_menu:zzz:o",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(tapped, true);
    assert.equal(flows.get(7, "42"), live, "живое меню не вытеснено");
    assert.equal(live.msgId, 100, "меню осталось за своим сообщением");
    assert.equal(live.awaitText, null, "ожидание ввода снято, а не перенесено");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "editMessageText" && call.body.message_id === 100,
      ),
      "корень перерисован в сообщении живого меню",
    );

    calls.length = 0;
    const ordinary = await handleControl(
      {
        update_id: 911,
        message: {
          message_id: 911,
          date: 1,
          chat,
          from: trustedFrom,
          text: "сколько времени?",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(ordinary, false, "обычное сообщение уходит в eve");
    assert.deepEqual(
      calls.map((call) => call.method),
      [],
      "обычное сообщение не удалено и не перехвачено",
    );
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

// Усыновление старого сообщения переносит ждущий ввод только на экран, который владеет
// его kind. Экран-получатель без texts[kind] обработать ввод не может, поэтому ожидание
// снимается, а корень рисуется в сообщении живого меню: иначе следующий ОБЫЧНЫЙ текст
// владельца снова удалялся бы из чата как ключ вместо доставки в eve.
test("adoption drops a pending input the target screen cannot handle", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const raw = init?.body;
    calls.push({
      method: url.split("/").at(-1) ?? "",
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    return Response.json({ ok: true, result: { message_id: 100 } });
  };
  try {
    // Живое меню ждёт ключ поиска (texts.apikey есть только у srch), тап приходит по
    // кнопке экрана языка в ДРУГОМ сообщении.
    const live = flows.start(7, "42", "menu", {
      screen: "srch",
      page: 0,
      msgId: 100,
      awaitText: { kind: "apikey", secret: true, data: { provider: "tavily" } },
    });

    const tapped = await handleControl(
      {
        update_id: 920,
        callback_query: {
          id: "cq-foreign-await",
          from: trustedFrom,
          message: { message_id: 55, date: 1, chat },
          data: "iva_menu:lang:o",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(tapped, true);
    assert.equal(flows.get(7, "42"), live, "живое меню не вытеснено");
    assert.equal(live.msgId, 100, "меню осталось за своим сообщением");
    assert.equal(live.awaitText, null, "ожидание ввода снято, а не перенесено");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "editMessageText" && call.body.message_id === 100,
      ),
      "корень перерисован в сообщении живого меню",
    );

    calls.length = 0;
    const ordinary = await handleControl(
      {
        update_id: 921,
        message: {
          message_id: 921,
          date: 1,
          chat,
          from: trustedFrom,
          text: "что по погоде?",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(ordinary, false, "обычное сообщение уходит в eve");
    assert.deepEqual(
      calls.map((call) => call.method),
      [],
      "обычное сообщение не удалено и не перехвачено",
    );
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

// Ожидание ввода принадлежит тому flow, который его поставил. Живой визард /model ждёт
// API-ключ (secret) в СВОЁМ сообщении; тап по старой кнопке меню не имеет права забрать ни
// это ожидание, ни общий слот — совпадение имени kind (у экрана поиска тоже есть
// texts.apikey) владением не является. Иначе ключ уходит обычной доставкой в eve и
// остаётся в чате.
test("a stale menu tap cannot take the pending key away from the /model wizard", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const raw = init?.body;
    calls.push({
      method: url.split("/").at(-1) ?? "",
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    return Response.json({ ok: true, result: { message_id: 100 } });
  };
  try {
    const wizard = flows.start(7, "42", "model", {
      provider: "custom",
      pendingBase: "https://api.example.test/v1",
      step: "awaiting_key",
      msgId: 100,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    const tapped = await handleControl(
      {
        update_id: 930,
        callback_query: {
          id: "cq-wizard-await",
          from: trustedFrom,
          message: { message_id: 55, date: 1, chat },
          data: "iva_menu:srch:o",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(tapped, true);
    assert.equal(flows.get(7, "42"), wizard, "слот визарда не вытеснен");
    assert.equal(wizard.flow, "model");
    assert.deepEqual(
      wizard.awaitText,
      { kind: "apikey", secret: true, data: {} },
      "ожидание осталось у визарда",
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["answerCallbackQuery"],
      "тап только гасит кнопку: ни правок сообщений, ни рендера",
    );
    assert.equal(
      typeof calls[0].body.text,
      "string",
      "в ack ушёл тост, а не тишина",
    );

    calls.length = 0;
    const keyMessage = await handleControl(
      {
        update_id: 931,
        message: {
          message_id: 931,
          date: 1,
          chat,
          from: trustedFrom,
          text: "sk-real-secret-value",
        },
      },
      recordingDeps().deps,
    );

    assert.equal(keyMessage, true, "ключ обработан визардом, а не доставкой");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "deleteMessage" && call.body.message_id === 931,
      ),
      "сообщение с ключом удалено из чата",
    );
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

// ── Характеристика handleControl: ветки, которые раньше не держал ни один тест ──

type BotCall = { method: string; body: Record<string, unknown> };

// Подменяет Bot API на время прогона: ответ решает respond(method), Error = обрыв сети.
async function withBotApi<T>(
  respond: (method: string) => unknown,
  run: (calls: BotCall[]) => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: BotCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = url.split("/").at(-1) ?? "";
    const raw = init?.body;
    calls.push({
      method,
      body:
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : {},
    });
    const answer = respond(method);
    if (answer instanceof Error) throw answer;
    return Response.json(answer);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

const botOk = () => ({ ok: true, result: { message_id: 500 } });
const botDown = () => new Error("network down");

function textUpdate(
  updateId: number,
  text: string | undefined,
  overrides: Record<string, unknown> = {},
): ControlUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat,
      from: trustedFrom,
      ...(text === undefined ? {} : { text }),
      ...overrides,
    },
  };
}

function callbackUpdate(updateId: number, data: string): ControlUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: trustedFrom,
      message: { message_id: updateId, date: 1, chat },
      data,
    },
  };
}

function dropFlow() {
  const stale = flows.get(7, "42");
  if (stale) {
    stale.createdAt = 0;
    flows.get(7, "42");
  }
}

const sentTexts = (calls: BotCall[]) =>
  calls.map((call) => JSON.stringify(call.body)).join("\n");

test("a wizard callback that throws is retained for the inbox", async () => {
  await withBotApi(botDown, async () => {
    assert.equal(
      await handleControl(callbackUpdate(1001, "iva_model:keep")),
      false,
    );
  });
});

test("a menu callback that throws is still consumed", async () => {
  await withBotApi(botDown, async () => {
    assert.equal(
      await handleControl(callbackUpdate(1002, "iva_menu:r:o")),
      true,
    );
  });
  dropFlow();
});

test("a command while input is awaited ends the wait and still runs", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "srch",
      msgId: 1003,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });
    const { replies, deps } = recordingDeps();

    assert.equal(await handleControl(textUpdate(1003, "/help"), deps), true);
    assert.equal(flows.get(7, "42"), null, "ожидание снято");
    assert.match(sentTexts(calls), /Отменено/u);
    assert.equal(replies.length, 1, "/help ответил");
  });
  dropFlow();
});

test("a menu screen claims the awaited text and never delivers it", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "r",
      msgId: 1004,
      awaitText: { kind: "nothing-handles-this", secret: false },
    });

    assert.equal(await handleControl(textUpdate(1004, "hello")), true);
    assert.equal(flows.get(7, "42"), null);
    assert.ok(!calls.some((call) => call.method === "deleteMessage"));
    assert.match(sentTexts(calls), /Обработчик ввода недоступен/u);
  });
  dropFlow();
});

test("a failing menu capture still consumes the secret", async () => {
  await withBotApi(botDown, async () => {
    flows.start(7, "42", "menu", {
      screen: "srch",
      msgId: 1005,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    assert.equal(
      await handleControl(textUpdate(1005, "tvly-secret-value")),
      true,
    );
  });
  dropFlow();
});

test("a failing wizard key intake still consumes the key", async () => {
  await withBotApi(botDown, async () => {
    flows.start(7, "42", "model", {
      provider: "custom",
      step: "awaiting_key",
      msgId: 1006,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    assert.equal(
      await handleControl(textUpdate(1006, "sk-secret-value")),
      true,
    );
  });
  dropFlow();
});

test("a photo while a secret is awaited is deleted and never reaches eve", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "srch",
      msgId: 1007,
      awaitText: { kind: "apikey", secret: true, data: {} },
    });

    const consumed = await handleControl(
      textUpdate(1007, undefined, { photo: [{ file_id: "p" }] }),
    );

    assert.equal(consumed, true);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["deleteMessage", "sendMessage"],
    );
    assert.match(sentTexts(calls), /текстом/u);
  });
  dropFlow();
});

test("a photo during a non-secret wait goes on to eve untouched", async () => {
  await withBotApi(botOk, async (calls) => {
    flows.start(7, "42", "menu", {
      screen: "r",
      msgId: 1008,
      awaitText: { kind: "interview" },
    });

    const consumed = await handleControl(
      textUpdate(1008, undefined, { photo: [{ file_id: "p" }] }),
    );

    assert.equal(consumed, false);
    assert.deepEqual(calls, []);
  });
  dropFlow();
});

test("/menu opens the menu in a private chat", async () => {
  await withBotApi(botOk, async (calls) => {
    assert.equal(await handleControl(textUpdate(1009, "/menu")), true);
    assert.ok(calls.length > 0, "экран меню отправлен");
    assert.equal(flows.get(7, "42")?.flow, "menu");
  });
  dropFlow();
});

test("a failing /menu is still consumed", async () => {
  await withBotApi(botDown, async () => {
    assert.equal(await handleControl(textUpdate(1010, "/menu")), true);
  });
  dropFlow();
});

test("/usage answers from the usage log without the model", async () => {
  await withBotApi(botOk, async (calls) => {
    assert.equal(await handleControl(textUpdate(1011, "/usage today")), true);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage"],
    );
  });
});

test("/usage names the reason when the log cannot be summarized", async () => {
  const usageLog = join(dataDir, "usage.jsonl");
  writeFileSync(usageLog, "null\n");
  try {
    await withBotApi(botOk, async (calls) => {
      assert.equal(await handleControl(textUpdate(1012, "/usage")), true);
      assert.match(sentTexts(calls), /Couldn't read the usage log: /u);
    });
  } finally {
    rmSync(usageLog, { force: true });
  }
});

test("/usage is retained when its reply fails", async () => {
  await withBotApi(
    () => ({ ok: false }),
    async () => {
      assert.equal(await handleControl(textUpdate(1013, "/usage")), false);
    },
  );
});

test("/update checks upstream and /update --force asks for a rebuild", async () => {
  await withBotApi(
    () => ({ ok: false }),
    async (calls) => {
      assert.equal(await handleControl(textUpdate(1014, "/update")), false);
      assert.equal(
        await handleControl(textUpdate(1015, "/update@iva_bot --force")),
        false,
      );
      assert.deepEqual(
        calls.map((call) => call.body.text),
        ["◇ Проверяю обновления", "◇ Пересобираю текущую версию"],
      );
    },
  );
});

for (const command of ["/model", "/think"]) {
  test(`${command} that throws is retained for the inbox`, async () => {
    await withBotApi(botDown, async () => {
      assert.equal(await handleControl(textUpdate(1016, command)), false);
    });
    dropFlow();
  });
}

// ── /new и /restart ──

type ResetCall = [string, Record<string, unknown>, Record<string, unknown>];

function resetDeps(
  performReset: () => Promise<unknown> = async () => {},
  { retryPending = false, intentPending = false } = {},
) {
  const resets: ResetCall[] = [];
  const replies: string[] = [];
  return {
    resets,
    replies,
    deps: {
      replyImpl: async (_chatId: number | undefined, text: string) => {
        replies.push(text);
        return { message_id: 900 };
      },
      performResetImpl: async (
        key: string,
        target: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        resets.push([key, target, options]);
        return performReset();
      },
      resetRetryPendingImpl: () => retryPending,
      resetIntentPendingImpl: () => intentPending,
    },
  };
}

function idleSession() {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: "session-r",
    turnId: null,
  });
}

const edits = (calls: BotCall[]) =>
  calls
    .filter((call) => call.method === "editMessageText")
    .map((call) => JSON.stringify(call.body));

// Журнал двойника systemctl: пусто — рестарта не было (файла ещё нет).
const systemctlCalls = (argsLog: string) =>
  existsSync(argsLog) ? readFileSync(argsLog, "utf8") : "";

// systemctl подменяется скриптом на PATH: тест никогда не трогает настоящий сервис.
async function withFakeSystemctl<T>(
  exitCode: number,
  run: (argsLog: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iva-systemctl-"));
  const argsLog = join(dir, "args.log");
  writeFileSync(
    join(dir, "systemctl"),
    `#!/bin/sh\necho "$@" >> "${argsLog}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  try {
    return await run(argsLog);
  } finally {
    process.env.PATH = previousPath;
  }
}

test("/new resets this private conversation and reports completion", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { resets, replies, deps } = resetDeps();

    assert.equal(await handleControl(textUpdate(1020, "/new"), deps), true);
    assert.deepEqual(resets, [
      [
        "7:",
        { sessionId: "session-r" },
        { clearQueue: true, discardThroughUpdateId: 1020 },
      ],
    ]);
    assert.equal(replies.length, 1);
    assert.equal(edits(calls).length, 1);
    assert.match(edits(calls)[0] ?? "", /"message_id":900/u);
  });
});

test("/restart restarts the service after the reset", async () => {
  idleSession();
  await withFakeSystemctl(0, async (argsLog) => {
    await withBotApi(botOk, async (calls) => {
      const { deps } = resetDeps();

      assert.equal(
        await handleControl(textUpdate(1021, "/restart"), deps),
        true,
      );
      assert.equal(
        readFileSync(argsLog, "utf8"),
        "--user restart iva.service\n",
      );
      assert.equal(edits(calls).length, 1);
      assert.doesNotMatch(edits(calls)[0] ?? "", /не удалось/u);
    });
  });
});

test("/restart says so when the service cannot restart", async () => {
  idleSession();
  await withFakeSystemctl(1, async () => {
    await withBotApi(botOk, async (calls) => {
      const { deps } = resetDeps();

      assert.equal(
        await handleControl(textUpdate(1022, "/restart"), deps),
        true,
      );
      assert.match(edits(calls)[0] ?? "", /перезапустить Iva не удалось/u);
    });
  });
});

const groupChat = { id: -100, type: "group" };

test("/new in a group without an addressed message names the problem", async () => {
  await withBotApi(botOk, async (calls) => {
    const { resets, deps } = resetDeps();

    assert.equal(
      await handleControl(textUpdate(1023, "/new", { chat: groupChat }), deps),
      true,
    );
    assert.deepEqual(resets, []);
    assert.match(edits(calls)[0] ?? "", /Не удалось определить этот диалог/u);
  });
});

test("an unidentified /new whose status reply failed is retained", async () => {
  const { resets, deps } = resetDeps();
  deps.replyImpl = async (_chatId, text) => {
    void text;
    return null as unknown as { message_id: number };
  };

  assert.equal(
    await handleControl(textUpdate(1024, "/new", { chat: groupChat }), deps),
    false,
  );
  assert.deepEqual(resets, []);
});

test("a failed group reset keeps the shared queue and is consumed", async () => {
  await withBotApi(botOk, async (calls) => {
    const { resets, deps } = resetDeps(async () => {
      throw new Error("cleanup failed");
    });
    const update = textUpdate(1025, "/new", {
      chat: groupChat,
      reply_to_message: {
        message_id: 50,
        date: 1,
        chat: groupChat,
        from: { id: 424242, is_bot: true },
      },
    });

    assert.equal(await handleControl(update, deps), true);
    assert.equal(resets.length, 1);
    assert.deepEqual(resets[0]?.[2], {
      clearQueue: false,
      discardThroughUpdateId: undefined,
    });
    assert.match(
      edits(calls)[0] ?? "",
      /Восстановление после сброса не завершено/u,
    );
  });
});

test("a failed private reset of unknown phase is thrown back for retry", async () => {
  idleSession();
  const failure = new Error("cleanup failed");
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw failure;
    });

    await assert.rejects(
      handleControl(textUpdate(1026, "/new"), deps),
      (error) => error === failure,
    );
    assert.match(
      edits(calls)[0] ?? "",
      /Восстановление после сброса не завершено/u,
    );
  });
});

test("a remote reset failure is left to recovery", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw Object.assign(new Error("eve down"), { resetPhase: "remote" });
    });

    assert.equal(await handleControl(textUpdate(1027, "/new"), deps), true);
    assert.match(edits(calls)[0] ?? "", /Не удалось подтвердить сброс/u);
  });
});

test("a backoff failure is consumed only while the reset intent is saved", async () => {
  idleSession();
  const backoff = () =>
    Promise.reject(
      Object.assign(new Error("backoff"), { resetPhase: "backoff" }),
    );
  await withBotApi(botOk, async (calls) => {
    const saved = resetDeps(backoff, { intentPending: true });
    assert.equal(
      await handleControl(textUpdate(1028, "/new"), saved.deps),
      true,
    );
    assert.match(edits(calls)[0] ?? "", /Повтор сброса уже запланирован/u);

    const unsaved = resetDeps(backoff, { intentPending: false });
    await assert.rejects(
      handleControl(textUpdate(1029, "/new"), unsaved.deps),
      /backoff/u,
    );
  });
});

test("an escalated intent failure tells the owner to run iva reset", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw Object.assign(new Error("disk"), {
        resetPhase: "intent",
        resetFailures: 1_000,
      });
    });

    assert.equal(await handleControl(textUpdate(1030, "/new"), deps), true);
    assert.match(edits(calls)[0] ?? "", /iva reset/u);
  });
});

test("an intent failure below the escalation bar is thrown back for retry", async () => {
  idleSession();
  await withBotApi(botOk, async (calls) => {
    const { deps } = resetDeps(async () => {
      throw Object.assign(new Error("disk"), {
        resetPhase: "intent",
        resetFailures: 1,
      });
    });

    await assert.rejects(
      handleControl(textUpdate(1031, "/new"), deps),
      /disk/u,
    );
    assert.doesNotMatch(edits(calls)[0] ?? "", /iva reset/u);
  });
});

test("a pending reset retry without saved intent holds the offset", async () => {
  idleSession();
  const { resets, replies, deps } = resetDeps(async () => {}, {
    retryPending: true,
    intentPending: false,
  });

  await assert.rejects(
    handleControl(textUpdate(1032, "/new"), deps),
    (error: { resetPhase?: unknown }) => error.resetPhase === "backoff",
  );
  assert.deepEqual(resets, []);
  assert.deepEqual(replies, []);
});

// ── handleAwaitNonText: ветки мимо удачной выгрузки ──

function recordingNonTextIo(download: string | null = "content") {
  const events: Array<string | [string, string]> = [];
  return {
    events,
    io: {
      deleteSecret: async () => {
        events.push("delete");
        return true;
      },
      download: async () => {
        events.push("download");
        return download;
      },
      deliver: async () => {
        events.push("deliver");
      },
      reply: async (_chatId: number | undefined, text: string) => {
        events.push(["reply", text]);
      },
    },
  };
}

const fileAwait = {
  flow: "menu",
  awaitText: { kind: "gws_client_secret", file: true },
};

test("an oversized secret file is deleted and never downloaded", async () => {
  const { events, io } = recordingNonTextIo();
  const consumed = await handleAwaitNonText(
    {
      message_id: 9,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 256 * 1024 + 1 },
    },
    fileAwait,
    io,
  );

  assert.equal(consumed, true);
  assert.equal(events.length, 2);
  assert.equal(events[0], "delete");
  assert.match((events[1] as [string, string])[1], /слишком большой/u);
});

test("an unreadable secret file asks for the contents as text", async () => {
  const { events, io } = recordingNonTextIo(null);
  const consumed = await handleAwaitNonText(
    {
      message_id: 10,
      chat: { id: 42 },
      document: { file_id: "file" },
    },
    fileAwait,
    io,
  );

  assert.equal(consumed, true);
  assert.deepEqual(events.slice(0, 2), ["delete", "download"]);
  assert.match((events[2] as [string, string])[1], /Не смог прочитать/u);
  assert.equal(events.length, 3);
});

test("a photo for a file prompt is deleted with a hint about the json file", async () => {
  const { events, io } = recordingNonTextIo();
  const consumed = await handleAwaitNonText(
    { message_id: 11, chat: { id: 42 }, photo: [{ file_id: "p" }] },
    fileAwait,
    io,
  );

  assert.equal(consumed, true);
  assert.equal(events[0], "delete");
  assert.match((events[1] as [string, string])[1], /client_secret\.json/u);
  assert.equal(events.length, 2);
});

test("a document outside the menu is deleted, not captured", async () => {
  const { events, io } = recordingNonTextIo();
  const consumed = await handleAwaitNonText(
    {
      message_id: 12,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 10 },
    },
    { flow: "model", awaitText: { kind: "apikey", secret: true } },
    io,
  );

  assert.equal(consumed, true);
  assert.equal(events[0], "delete");
  assert.match((events[1] as [string, string])[1], /текстом/u);
  assert.equal(events.length, 2);
});
