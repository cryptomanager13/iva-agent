// Контракт хода напоминания: он длится, пока идут события (потолка длительности нет),
// молчащий стрим гасится на окне тишины, а пока ход идёт — чат видит его сессию, чтобы
// ⏹ и /stop гасили её тем же путём, что и ход канала. Самой записи в run-status ход не
// знает: её передаёт хозяин хода (scripts/reminders/fire.ts) зависимостью, иначе модуль
// не загрузился бы на установке без agent/.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateClient,
  ReminderClient,
  ReminderClientOptions,
  TurnStreamEvent,
  TurnWatch,
} from "./reminder-turn.ts";

const { ReminderTurnError, runReminderTurn } =
  await import("./reminder-turn.ts");

const OPTIONS: ReminderClientOptions = {
  host: "http://127.0.0.1:8723",
  auth: { bearer: () => Promise.resolve("bearer") },
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type TurnSpy = {
  readonly createClient: CreateClient;
  readonly prompts: string[];
  readonly sent: string[];
  readonly resets: string[];
  readonly cancelCount: () => number;
};

type WatchCalls = {
  readonly claimed: string[];
  readonly pulsed: string[];
  readonly released: string[];
};

/** Присмотр чата, каким его видит ход: запись живёт в fire.ts, здесь важен только контракт. */
function watchSpy(claim = true): { watch: TurnWatch; calls: WatchCalls } {
  const calls: WatchCalls = { claimed: [], pulsed: [], released: [] };
  return {
    watch: {
      claim: (sessionId) => {
        calls.claimed.push(sessionId);
        return Promise.resolve(claim);
      },
      pulse: (sessionId) => {
        calls.pulsed.push(sessionId);
      },
      release: (sessionId) => {
        calls.released.push(sessionId);
      },
    },
    calls,
  };
}

// A turn reads its response as a stream and cancels it cooperatively, the way eve's
// MessageResponse does; the session records what the turn told it to do.
function spyTurn(
  events: (cancelled: Promise<void>) => AsyncGenerator<TurnStreamEvent>,
  sessionId = "sess-1",
): TurnSpy {
  const prompts: string[] = [];
  const sent: string[] = [];
  const resets: string[] = [];
  let cancels = 0;
  let releaseCancel = (): void => {};
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const response = Object.assign(events(cancelled), {
    cancel: () => {
      cancels += 1;
      releaseCancel();
      return Promise.resolve();
    },
    sessionId,
  });
  const client: ReminderClient = {
    sessions: {
      create: (input) => {
        prompts.push(input.message);
        return Promise.resolve({
          response,
          session: {
            send: (message) => {
              sent.push(message);
              return Promise.resolve();
            },
            reset: ({ reason }) => {
              resets.push(reason);
              return Promise.resolve();
            },
          },
        });
      },
    },
  };
  return {
    createClient: () => Promise.resolve(client),
    prompts,
    sent,
    resets,
    cancelCount: () => cancels,
  };
}

function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

void test("the last message.completed text is returned and the session is reset", async () => {
  const spy = spyTurn(async function* () {
    // Each gap stays under the idle window while the whole turn runs past it: a window that
    // is only armed once, instead of once per event, has to cut this stream off.
    for (const event of [
      { type: "step.started" },
      { type: "message.appended" },
      { type: "message.completed", data: { message: "draft" } },
      { type: "message.completed", data: { message: null } },
      { type: "message.completed", data: { message: "final" } },
      { type: "reasoning.appended" },
      { type: "action.result" },
      { type: "session.waiting" },
    ] as const) {
      await delay(40);
      yield event;
    }
  });

  const turn = await runReminderTurn("сформулируй напоминание", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 200,
  });

  assert.deepEqual(spy.prompts, ["сформулируй напоминание"]);
  assert.equal(turn.status, "waiting");
  assert.equal(turn.message, "final");
  assert.equal(turn.cancelled, false);
  await turn.feedback("hint");
  assert.deepEqual(spy.sent, ["hint"]);
  assert.deepEqual(spy.resets, ["Reminder finished"]);
});

void test("a silent stream is cancelled at the idle window, never swallowed", async () => {
  const silent = spyTurn(async function* (cancelled) {
    await delay(40);
    yield { type: "step.started" };
    // The turn hangs here; the window has to cut the silence, and cancel() is the only
    // thing that ends the wait.
    await Promise.race([cancelled, delay(400)]);
  });

  const idle = await failureOf(
    runReminderTurn("зависни", OPTIONS, {
      createClient: silent.createClient,
      inactivityMs: 80,
    }),
  );

  assert.ok(idle instanceof ReminderTurnError);
  assert.match(idle.message, /no activity for 80ms/u);
  assert.equal(silent.cancelCount(), 1);
  assert.deepEqual(silent.resets, ["Reminder finished"]);
});

void test("a turn that keeps sending events lasts many idle windows and ends on its own boundary", async () => {
  const talkative = spyTurn(async function* () {
    // Events arrive faster than the idle window, so the turn outlives it many times over
    // and only the stream's own boundary may end it: no wall-clock cap cuts a working turn.
    for (let count = 0; count < 40; count += 1) {
      await delay(5);
      yield { type: "step.started" };
    }
    yield { type: "message.completed", data: { message: "готово" } };
    yield { type: "session.completed" };
  });

  const long = await runReminderTurn("работай долго", OPTIONS, {
    createClient: talkative.createClient,
    inactivityMs: 60,
  });

  assert.equal(long.status, "completed");
  assert.equal(long.message, "готово");
  assert.equal(long.cancelled, false);
  assert.equal(talkative.cancelCount(), 0, "рабочий ход никто не гасил");
  assert.deepEqual(talkative.resets, ["Reminder finished"]);
});

void test("the turn claims the chat for the whole run and releases it when it ends", async () => {
  const { watch, calls } = watchSpy();
  const seen: string[][] = [];
  const spy = spyTurn(async function* () {
    // ⏹ и /stop ищут сессию хода именно здесь, поэтому запись обязана существовать уже
    // на первом событии, а не появиться к концу хода.
    seen.push([...calls.claimed]);
    await delay(0);
    yield { type: "message.completed", data: { message: "готово" } };
    yield { type: "session.completed" };
  }, "sess-run");

  const turn = await runReminderTurn("напиши статью", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
    watch,
  });

  assert.deepEqual(seen, [["sess-run"]], "чат занят на первом же событии хода");
  assert.equal(turn.status, "completed");
  assert.deepEqual(calls.claimed, ["sess-run"]);
  assert.deepEqual(calls.released, ["sess-run"]);
  // Пульс идёт по событиям хода: без него долгий ход выглядит протухшим и стоп слепнет.
  assert.ok(calls.pulsed.includes("sess-run"), calls.pulsed.join(","));
  assert.deepEqual(
    [...new Set(calls.pulsed)],
    ["sess-run"],
    "пульс — только своя сессия",
  );
});

void test("a stalled turn releases the chat too", async () => {
  const { watch, calls } = watchSpy();
  const spy = spyTurn(async function* (cancelled) {
    yield { type: "step.started" };
    await Promise.race([cancelled, delay(400)]);
  }, "sess-stall");

  const stalled = await failureOf(
    runReminderTurn("зависни", OPTIONS, {
      createClient: spy.createClient,
      inactivityMs: 40,
      watch,
    }),
  );

  assert.ok(stalled instanceof ReminderTurnError);
  assert.deepEqual(calls.released, ["sess-stall"], "запись снята и на провале");
});

void test("a chat taken by another turn is left alone: no record, no release", async () => {
  const { watch, calls } = watchSpy(false);
  const spy = spyTurn(async function* () {
    await delay(0);
    yield { type: "message.completed", data: { message: "готово" } };
    yield { type: "session.completed" };
  }, "sess-busy");

  const turn = await runReminderTurn("напиши статью", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
    watch,
  });

  assert.equal(turn.status, "completed", "ход всё равно работает");
  assert.deepEqual(calls.claimed, ["sess-busy"]);
  assert.deepEqual(calls.pulsed, [], "чужую запись пульсом не трогаем");
  assert.deepEqual(calls.released, [], "и не снимаем чужое");
});

void test("a cancelled turn is a cancellation even when the stream has no boundary", async () => {
  const spy = spyTurn(async function* () {
    // Границы сессии нет вовсе: eve штатно шлёт её после отмены, но признак отмены
    // терять нельзя — иначе код отправит владельцу дословный текст напоминания.
    await delay(0);
    yield { type: "turn.cancelled" };
  }, "sess-cut");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
  });

  assert.equal(turn.cancelled, true);
  assert.equal(turn.status, "waiting");
  assert.deepEqual(spy.resets, ["Reminder finished"]);
});

void test("a stream that breaks right after the cancellation still comes back cancelled", async () => {
  const spy = spyTurn(async function* () {
    // Боевой /stop: eve успел сказать turn.cancelled, session.* не прислал, и связь
    // оборвалась — обрыв не имеет права отменить отмену.
    await delay(0);
    yield { type: "turn.cancelled" };
    throw new Error("stream reset by peer");
  }, "sess-broken");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
  });

  assert.equal(turn.cancelled, true, "отмену видно вызывающему и на обрыве");
  assert.equal(turn.status, "waiting");
  assert.deepEqual(spy.resets, ["Reminder finished"], "сессия погашена");
});

void test("the owner's stop ends the turn as cancelled, not as a failure", async () => {
  const { watch, calls } = watchSpy();
  const spy = spyTurn(async function* () {
    // Ровно это eve шлёт ходу, который погасили снаружи: turn.cancelled → session.waiting.
    await delay(0);
    yield { type: "turn.cancelled" };
    yield { type: "session.waiting" };
  }, "sess-cancel");

  const turn = await runReminderTurn("долгая работа", OPTIONS, {
    createClient: spy.createClient,
    inactivityMs: 1_000,
    watch,
  });

  assert.equal(turn.status, "waiting");
  assert.equal(turn.cancelled, true, "отмену видно вызывающему");
  assert.equal(spy.cancelCount(), 0, "гасил владелец, а не сторож тишины");
  assert.deepEqual(
    calls.released,
    ["sess-cancel"],
    "запись снята и после отмены",
  );
});
