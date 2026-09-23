import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { ClientError } from "eve/client";
import {
  cancelTurnAndConfirmQuietly,
  canRetryFresh,
  isSessionNotActiveError,
  RollupTurnTimeoutError,
  resolveStopAt,
  withTurnTimeout,
} from "./rollup-turn.ts";
import { DEFAULT_TIMEOUT_MS, JOB_STOP_GRACE_MS } from "#lib/schedule-runner.ts";

interface TestTurnResult {
  readonly events?: readonly { readonly type?: string }[];
}

interface TestResponse {
  result(): Promise<TestTurnResult>;
}

interface RetryPolicyOptions {
  readonly firstSend: (recordSend: () => void) => Promise<TestResponse>;
  readonly cancel: () => Promise<{ status?: string }>;
}

void test("fresh retry requires session_not_active or confirmed cancellation", () => {
  assert.equal(
    canRetryFresh({
      cancelConfirmed: false,
      sessionNotActive: false,
    }),
    false,
  );
  assert.equal(
    canRetryFresh({
      cancelConfirmed: true,
      sessionNotActive: false,
    }),
    true,
  );
  assert.equal(
    canRetryFresh({
      cancelConfirmed: false,
      sessionNotActive: true,
    }),
    true,
  );
});

void test("only a structured 409 session_not_active proves send rejection", () => {
  assert.equal(
    isSessionNotActiveError({ status: 409, code: "session_not_active" }),
    true,
  );
  assert.equal(
    isSessionNotActiveError({ status: 500, code: "session_not_active" }),
    false,
  );
  assert.equal(isSessionNotActiveError({ status: 409, code: "other" }), false);
  assert.equal(isSessionNotActiveError(new Error("session_not_active")), false);
});

async function countSendsThroughRetryPolicy({
  firstSend,
  cancel,
}: RetryPolicyOptions): Promise<number> {
  let sends = 0;
  let sessionNotActive = false;
  let acceptedTurnResult: Promise<TestTurnResult> | undefined;
  try {
    await withTurnTimeout(
      async () => {
        let response;
        try {
          response = await firstSend(() => {
            sends += 1;
          });
        } catch (error) {
          sessionNotActive = isSessionNotActiveError(error);
          throw error;
        }
        acceptedTurnResult = response.result();
        return await acceptedTurnResult;
      },
      { timeoutMs: 20, label: "main-turn" },
    );
  } catch {
    // Это точная модель catch-флоу rollup.ts, а не выполнение самого rollup.ts.
    const cancelConfirmed = !sessionNotActive
      ? await cancelTurnAndConfirmQuietly({ cancel }, acceptedTurnResult, {
          timeoutMs: 20,
        })
      : false;
    if (canRetryFresh({ sessionNotActive, cancelConfirmed })) sends += 1;
  }
  return sends;
}

void test("an accepted hung turn with refused cancellation never sends a fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.resolve({
        result: () => new Promise<TestTurnResult>(() => {}),
      });
    },
    cancel: () => Promise.reject(new Error("cancel refused")),
  });
  assert.equal(sends, 1);
});

void test("an accepted cancel response without a terminal cancelled event blocks fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.resolve({
        result: () => new Promise<TestTurnResult>(() => {}),
      });
    },
    cancel: () => Promise.resolve({ status: "accepted" }),
  });
  assert.equal(sends, 1);
});

void test("an accepted hung turn retries after the stream confirms turn.cancelled", async () => {
  let finishTurn: (value: TestTurnResult) => void;
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.resolve({
        result: () =>
          new Promise<TestTurnResult>((resolve) => {
            finishTurn = resolve;
          }),
      });
    },
    cancel: () => {
      finishTurn!({
        events: [{ type: "turn.cancelled" }, { type: "session.waiting" }],
      });
      return Promise.resolve({ status: "accepted" });
    },
  });
  assert.equal(sends, 2);
});

void test("a hung send with refused cancellation never sends a fresh retry", async () => {
  let cancels = 0;
  const sends = await countSendsThroughRetryPolicy({
    firstSend: async (recordSend) => {
      recordSend();
      return await new Promise<TestResponse>(() => {});
    },
    cancel: () => {
      cancels += 1;
      return Promise.resolve({ status: "accepted" });
    },
  });
  assert.equal(sends, 1);
  assert.equal(cancels, 1);
});

void test("a hung send gets one fresh retry when cancel reports no active turn", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: async (recordSend) => {
      recordSend();
      return await new Promise<TestResponse>(() => {});
    },
    cancel: () => Promise.resolve({ status: "no_active_turn" }),
  });
  assert.equal(sends, 2);
});

void test("a disconnected send does not retry without confirmed cancellation", async () => {
  let cancels = 0;
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.reject(new TypeError("fetch failed"));
    },
    cancel: () => {
      cancels += 1;
      return Promise.resolve({ status: "accepted" });
    },
  });
  assert.equal(sends, 1);
  assert.equal(cancels, 1);
});

void test("a structured session_not_active rejection gets one fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.reject(
        new ClientError(
          409,
          JSON.stringify({ code: "session_not_active", error: "inactive" }),
        ),
      );
    },
    cancel: () =>
      Promise.reject(new Error("inactive sessions do not need cancellation")),
  });
  assert.equal(sends, 2);
});

void test("a turn that finishes in time returns its result", async () => {
  const result = await withTurnTimeout(() => Promise.resolve("report"), {
    timeoutMs: 50,
    label: "main-turn",
  });
  assert.equal(result, "report");
});

void test("a hung turn rejects with a labelled timeout error", async () => {
  await assert.rejects(
    withTurnTimeout(() => new Promise<never>(() => {}), {
      timeoutMs: 20,
      label: "main-turn",
    }),
    (e) => {
      assert.ok(e instanceof RollupTurnTimeoutError);
      assert.equal(e.code, "ROLLUP_TURN_TIMEOUT");
      assert.equal(e.label, "main-turn");
      assert.deepEqual(Object.keys(e), ["name", "code", "label"]);
      return true;
    },
  );
});

void test("the timer is cleared, so the next turn runs right after a win", async () => {
  assert.equal(
    await withTurnTimeout(() => Promise.resolve(1), {
      timeoutMs: 60_000,
      label: "first",
    }),
    1,
  );
  assert.equal(
    await withTurnTimeout(() => Promise.resolve(2), {
      timeoutMs: 60_000,
      label: "second",
    }),
    2,
  );
  // Файл теста завершается сам: незачищенный минутный таймер держал бы event loop.
});

// Свойства: при провале fast-check печатает { seed, path } — подставь их вторым
// аргументом fc.assert, и прогон повторится байт в байт.
const NOW = 1_800_000_000_000;

void test("the configured stop time is taken only when it is a sane epoch in milliseconds", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: NOW + 2 ** 31 - 1 }), (stopAt) => {
      assert.equal(resolveStopAt(String(stopAt), NOW), stopAt);
    }),
  );
  // Ручной запуск мимо раннера получает тот же потолок расписания от своего старта.
  assert.equal(
    resolveStopAt(undefined, NOW),
    NOW + DEFAULT_TIMEOUT_MS - JOB_STOP_GRACE_MS,
  );
  assert.equal(resolveStopAt("", NOW), resolveStopAt(undefined, NOW));
});

void test("a malformed stop time is refused instead of falling back to a default", () => {
  // Тихий дефолт снова развёл бы срок хода и потолок расписания; число за пределом
  // 32-битного таймера Node схлопнул бы в 1 мс.
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string().filter((raw) => raw !== "" && !/^\d+$/u.test(raw)),
        fc
          .bigInt({ min: BigInt(NOW) + 2n ** 31n, max: 10n ** 30n })
          .map(String),
      ),
      (raw) => {
        assert.throws(() => resolveStopAt(raw, NOW), /IVA_JOB_STOP_AT=/u);
      },
    ),
  );
});

const quick = { timeoutMs: 30 };

void test("a hung cancel is swallowed instead of blocking the exit", async () => {
  const hung = { cancel: () => new Promise<{ status?: string }>(() => {}) };
  assert.equal(
    await cancelTurnAndConfirmQuietly(hung, undefined, quick),
    false,
  );
});

void test("a refused cancel is swallowed too", async () => {
  // Не начатая сессия бросает синхронно, заклинившая может ответить 500 — оба исхода не наши.
  const throws = {
    cancel: (): Promise<{ status?: string }> => {
      throw new Error("session has not started");
    },
  };
  const rejects = {
    cancel: (): Promise<{ status?: string }> =>
      Promise.reject(new Error("500 cancel-turn")),
  };
  assert.equal(
    await cancelTurnAndConfirmQuietly(throws, undefined, quick),
    false,
  );
  assert.equal(
    await cancelTurnAndConfirmQuietly(rejects, undefined, quick),
    false,
  );
});

void test("a cancel with no active turn reports success and stops the spawned tasks too", async () => {
  const seen: unknown[] = [];
  const session = {
    cancel: (options?: unknown) => {
      seen.push(options);
      return Promise.resolve({ status: "no_active_turn" });
    },
  };
  assert.equal(
    await cancelTurnAndConfirmQuietly(session, undefined, quick),
    true,
  );
  assert.deepEqual(seen, [{ tasks: true }]);
});
