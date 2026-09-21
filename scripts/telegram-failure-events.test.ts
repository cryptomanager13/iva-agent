/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ChannelSource, RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";

const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-failures-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "failure-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "failure-test-secret";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST; // адрес самовызова cancel-роута должен быть предсказуем

type ApiBody = Record<string, unknown> & {
  chat_id?: unknown;
  message_id?: unknown;
  text?: unknown;
};
type ApiCall = { method: string | undefined; body: ApiBody | undefined };
type HeldSend = {
  chatId: string;
  release: Promise<void>;
  startedResolve: () => void;
};
type EventOptions = {
  chatId: string;
  sessionId: string;
};
type ChannelEventHandler = (
  data: Record<string, unknown>,
  context: unknown,
) => void | Promise<void>;
type FailureAdapter = {
  state?: Record<string, unknown>;
  createAdapterContext: (base: {
    ctx: unknown;
    session: {
      id: string;
      auth: { current: null; initiator: null };
      continuation: { token: string; rekey: (token: string) => void };
    };
    state: Record<string, unknown>;
  }) => unknown;
  "turn.failed": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
  "session.failed": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
  "session.waiting": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
  "turn.started": ChannelEventHandler;
  "actions.requested": ChannelEventHandler;
  "action.partial": ChannelEventHandler;
  "action.result": ChannelEventHandler;
  "message.appended": ChannelEventHandler;
  "message.completed": ChannelEventHandler;
};

const apiCalls: ApiCall[] = [];
const hitlResponses: unknown[][] = [];
let heldSend: HeldSend | undefined;
// Ответ cancel-роута для следующего теста: обычно ход действительно отменяется.
let cancelRouteStatus: "accepted" | "no_active_turn" = "accepted";
globalThis.fetch = async (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
  const requestUrl = String(url);
  const method = new URL(requestUrl).pathname.split("/").at(-1);
  const body: ApiBody | undefined = init.body
    ? (JSON.parse(
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
        String(init.body),
      ) as ApiBody)
    : undefined;
  apiCalls.push({ method, body });
  // Самовызов cancel-роута каналом (кнопка ⏹ Стоп в webhook-режиме) — не Bot API.
  if (requestUrl.endsWith("/eve/v1/telegram/cancel")) {
    const status = cancelRouteStatus;
    if (status === "accepted") finishCancelledTurn(body?.sessionId);
    return Response.json({ ok: true, status });
  }
  const hold = heldSend;
  if (method === "sendMessage" && hold?.chatId === String(body?.chat_id)) {
    hold.startedResolve();
    await hold.release;
    if (heldSend === hold) heldSend = undefined;
  }
  return Response.json({
    ok: true,
    result: {
      message_id: 1000 + apiCalls.length,
      chat: { id: body?.chat_id ?? 7, type: "private" },
    },
  });
};

const telegramTestModule = "../agent/channels/telegram.ts?failure-events-test";
const [
  { default: channel },
  { chatKeyOf, getChatStatus, setChatStatus },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(telegramTestModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("#lib/run-status.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);

const adapter = (channel as unknown as { adapter: FailureAdapter }).adapter;

// Журнал хода (ADR-0010): «Стоп» пишет свой исход из ЕДИНОЙ политики остановки, поэтому
// одинаково виден и в webhook-режиме, и через мост.
const trace = await import("#lib/trace.ts");

function traceEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(trace.traceFilePath(trace.traceDay(), dataDir), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return []; // журнала ещё нет — событий тоже
  }
}

after(() => rmSync(dataDir, { recursive: true, force: true }));

function eventContext({ chatId, sessionId }: EventOptions) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_0", sequence: 0 },
  });
  const session = {
    id: sessionId,
    auth: { current: null, initiator: null } as const,
    continuation: {
      token: `telegram:${chatId}::`,
      rekey() {},
    },
  };
  const state = {
    ...adapter.state,
    chatId: String(chatId),
    chatType: "private",
    messageThreadId: null,
  };
  return {
    ctx,
    value: adapter.createAdapterContext({ ctx, session, state }),
  };
}

async function emitTurnFailed(
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter["turn.failed"](data, context.value),
  );
}

async function emitSessionFailed(
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await adapter["session.failed"](data, context.value);
}

async function emitSessionWaiting(options: EventOptions) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter["session.waiting"]({}, context.value),
  );
}

function callsSince(index: number, method: string) {
  return apiCalls.slice(index).filter((call) => call.method === method);
}

function holdSend(chatId: string) {
  let startedResolve!: () => void;
  let releaseResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  heldSend = {
    chatId: String(chatId),
    release,
    startedResolve,
  };
  return { release: releaseResolve, started };
}

test("turn.failed posts a humanized error with error id even when finishStatus CAS misses", async () => {
  const chatId = "701";
  const sessionId = "failed-session-cas-miss";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "newer-session",
    turnId: "turn_newer",
  });
  const before = apiCalls.length;
  const turnData = {
    code: "MODEL_CALL_FAILED",
    details: {
      errorId: "err-limit-701",
      statusCode: 429,
      upstreamMessage: "5-hour usage limit reached. Resets in 3hr 59min.",
    },
    message: "Request rejected",
    sequence: 0,
    turnId: "turn_0",
  };

  await emitTurnFailed(turnData, { chatId, sessionId });

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  assert.equal(
    sends[0].body!.text,
    "Provider limit exhausted - resets in 3hr 59min; wait or switch models: /model\n\nError id: err-limit-701",
  );
  assert.equal(getChatStatus(key)!.sessionId, "newer-session");

  await emitSessionFailed(
    {
      code: turnData.code,
      details: turnData.details,
      message: turnData.message,
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("session.failed clears its run-status and deduplicates repeated delivery", async () => {
  const chatId = "702";
  const sessionId = "terminal-session-cleanup";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
    statusMessageId: 55,
  });
  const before = apiCalls.length;
  const data = {
    code: "MODEL_CALL_FAILED",
    details: { errorId: "err-billing-702", statusCode: 402 },
    message: "Request rejected",
    sessionId,
  };

  await emitSessionFailed(data, { chatId, sessionId });

  const status = getChatStatus(key);
  assert.equal(status!.status, "idle");
  assert.equal(status!.sessionId, undefined);
  assert.equal(status!.turnId, undefined);
  assert.equal(callsSince(before, "deleteMessage").length, 1);
  assert.equal(callsSince(before, "deleteMessage")[0].body!.message_id, 55);
  assert.equal(callsSince(before, "sendMessage").length, 1);
  assert.equal(
    callsSince(before, "sendMessage")[0].body!.text,
    "Provider balance/plan exhausted - top up or switch models: /model\n\nError id: err-billing-702",
  );

  await emitSessionFailed(data, { chatId, sessionId });
  assert.equal(callsSince(before, "sendMessage").length, 1);
});

// session.waiting — страховка при потерянном terminal-событии (краш хода): парковка
// сессии обязана не только снять busy-флаг, но и удалить осиротевший «Работаю…/Стоп»,
// иначе индикатор висит в чате до ручной уборки.
test("session.waiting after a lost terminal event deletes the orphan working indicator", async () => {
  const chatId = "704";
  const sessionId = "parked-session-lost-terminal";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
    statusMessageId: 66,
    ingressId: "ingress-704",
  });
  const before = apiCalls.length;

  await emitSessionWaiting({ chatId, sessionId });

  const status = getChatStatus(key);
  assert.equal(status!.status, "idle");
  assert.equal(status!.sessionId, undefined);
  assert.equal(status!.turnId, undefined);
  assert.equal(status!.statusMessageId, undefined);
  assert.equal(status!.ingressId, undefined);
  const deletes = callsSince(before, "deleteMessage");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].body!.message_id, 66);
});

test("session.waiting after normal cleanup or for a stale session is a no-op", async () => {
  const chatId = "705";
  const key = chatKeyOf(chatId);
  // Обычный финал: turn.completed уже прибрал статус — парковка ничего не трогает.
  setChatStatus(key, {
    status: "idle",
    sessionId: null,
    statusMessageId: null,
  });
  const before = apiCalls.length;
  await emitSessionWaiting({ chatId, sessionId: "already-cleaned" });
  assert.equal(callsSince(before, "deleteMessage").length, 0);
  assert.equal(getChatStatus(key)!.status, "idle");

  // Запоздавший session.waiting старой сессии не должен убить бегущий новый ход.
  setChatStatus(key, {
    status: "running",
    sessionId: "newer-session",
    turnId: "turn_1",
    statusMessageId: 90,
  });
  await emitSessionWaiting({ chatId, sessionId: "stale-session" });
  const status = getChatStatus(key);
  assert.equal(status!.status, "running");
  assert.equal(status!.sessionId, "newer-session");
  assert.equal(status!.statusMessageId, 90);
  assert.equal(callsSince(before, "deleteMessage").length, 0);
});

test("turn.failed claims notification before an overlapping session.failed can post", async () => {
  const chatId = "703";
  const sessionId = "terminal-session-overlap";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
  });
  const before = apiCalls.length;
  const details = { errorId: "err-upstream-703" };
  const hold = holdSend(chatId);
  const turn = emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId },
  );
  await hold.started;

  await emitSessionFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
  hold.release();
  await turn;
  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("two failed turns of one session within a minute both post", async () => {
  const chatId = "707";
  const sessionId = "two-turns-session";
  setChatStatus(chatKeyOf(chatId), {
    status: "running",
    sessionId,
    turnId: "turn_0",
  });
  const before = apiCalls.length;

  await emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details: { errorId: "err-1" },
      message: "Upstream request failed",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId },
  );
  await emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details: { errorId: "err-2" },
      message: "Upstream request failed",
      sequence: 1,
      turnId: "turn_1",
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 2);
});

// Уведомление о сбое собирается из runtime-контента (текст провайдера, errorId), и до
// Bot API оно доходит через шов канала (noticeSender). Планты — под generic_key и под
// формат телеграм-токена; проверяем то, что реально ушло в теле запроса.
const PLANTED_KEY = `api_key=${"z".repeat(24)}`;
const PLANTED_BOT_TOKEN = `1234567890:${"A".repeat(35)}`;

function mutedConsole() {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

test("turn.failed redacts a provider key before it reaches Bot API", async () => {
  const chatId = "706";
  const restore = mutedConsole();
  const before = apiCalls.length;
  try {
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err-key-706" },
        message: `Incorrect API key provided: ${PLANTED_KEY}`,
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId: "failed-session-key" },
    );
  } finally {
    restore();
  }

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  const text = String(sends[0].body!.text);
  assert.equal(text.includes("zzzz"), false);
  assert.equal(text.includes("[REDACTED]"), true);
  assert.equal(text.endsWith("Error id: err-key-706"), true);
});

// errorId никто не чистит по дороге: если шов канала снять, ключ уедет в чат целым.
test("turn.failed redacts a secret carried by errorId itself", async () => {
  const chatId = "707";
  const restore = mutedConsole();
  const before = apiCalls.length;
  try {
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: PLANTED_KEY },
        message: "Provider returned a strange response",
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId: "failed-session-error-id" },
    );
  } finally {
    restore();
  }

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  const text = String(sends[0].body!.text);
  assert.equal(text.includes("zzzz"), false);
  assert.equal(text.endsWith("Error id: [REDACTED]"), true);
});

// Худший вход разом: пусто в message, многострочный стек и оба секрета в одной ошибке.
test("session.failed survives an empty error and redacts a multi-line one", async () => {
  const restore = mutedConsole();
  const emptyBefore = apiCalls.length;
  try {
    await emitSessionFailed(
      { code: "MODEL_CALL_FAILED", message: "", sessionId: "failed-empty" },
      { chatId: "708", sessionId: "failed-empty" },
    );
    const empty = callsSince(emptyBefore, "sendMessage");
    assert.equal(empty.length, 1);
    assert.equal(empty[0].body!.text, "Turn failed: Unknown provider error");

    const before = apiCalls.length;
    await emitSessionFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err-hostile-709" },
        message: `bot ${PLANTED_BOT_TOKEN} rejected the call: ${PLANTED_KEY}\nat stack ${PLANTED_KEY}`,
        sessionId: "failed-hostile",
      },
      { chatId: "709", sessionId: "failed-hostile" },
    );
    const sends = callsSince(before, "sendMessage");
    assert.equal(sends.length, 1);
    const text = String(sends[0].body!.text);
    assert.equal(text.includes("zzzz"), false);
    assert.equal(text.includes("AAAA"), false);
    assert.equal(text.includes("at stack"), false);
    assert.equal(text.includes("[REDACTED]"), true);
  } finally {
    restore();
  }
});

// --- Проводка пульса живого хода ---
//
// Пульс держится на ЧЕТЫРЁХ обработчиках событий канала (agent/channels/telegram.ts).
// Сама функция markTelegramTurnAlive проверена в agent/lib/telegram-turn-start.test.ts,
// но её вызов из обработчика — отдельный провод: убрать его, и жнец снова начнёт снимать
// живой молчаливый ход, а все юнит-тесты останутся зелёными. Здесь дёргается настоящий
// адаптер канала, а результат читается из настоящего run-status.
const HEARTBEAT_EVENTS = [
  ["actions.requested", { actions: [], sequence: 0, turnId: "turn_0" }],
  [
    "action.partial",
    { result: {}, sequence: 1, stepIndex: 0, turnId: "turn_0" },
  ],
  [
    "action.result",
    { result: {}, sequence: 2, stepIndex: 0, turnId: "turn_0" },
  ],
  ["message.appended", { message: {}, sequence: 3 }],
] as const;

async function emitChannelEvent(
  name: (typeof HEARTBEAT_EVENTS)[number][0],
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter[name](data, context.value),
  );
}

test("every live-turn event refreshes run-status, and actions.requested keeps Eve's typing default", async () => {
  let chatIdSeed = 710;
  for (const [name, data] of HEARTBEAT_EVENTS) {
    // Свой чат на событие: пульс дросселирован одной записью в минуту на чат.
    const chatId = String(chatIdSeed++);
    const sessionId = `alive-${name}`;
    const key = chatKeyOf(chatId);
    // firstOutputAt проставлен заранее: иначе отметка первого вывода в message.appended
    // сама сделала бы запись и замаскировала отсутствие пульса.
    setChatStatus(key, {
      status: "running",
      sessionId,
      turnId: "turn_0",
      firstOutputAt: 1,
    });
    const before = getChatStatus(key)!;
    const apiBefore = apiCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 5)); // Date.now() ходит по миллисекундам

    await emitChannelEvent(name, { ...data }, { chatId, sessionId });

    const after = getChatStatus(key)!;
    assert.equal(
      after.generation,
      (before.generation as number) + 1,
      `${name}: пульс не дошёл до run-status`,
    );
    assert.ok(
      (after.updatedAt as number) > (before.updatedAt as number),
      `${name}: updatedAt не двинулся, жнец снимет живой ход`,
    );
    assert.equal(after.status, "running", `${name}: пульс сменил статус`);
    assert.equal(after.sessionId, sessionId, `${name}: пульс сменил сессию`);

    // Дефолт eve на actions.requested — обновить «печатает…». Переопределяя событие,
    // канал обязан сохранить это сам.
    assert.equal(
      callsSince(apiBefore, "sendChatAction").length,
      name === "actions.requested" ? 1 : 0,
      `${name}: индикатор набора`,
    );
  }
});

test("a heartbeat from a finished or foreign turn is refused by the same wiring", async () => {
  const chatId = "719";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "live-session",
    turnId: "turn_0",
    firstOutputAt: 1,
  });
  const before = getChatStatus(key)!;

  // Опоздавшее событие уже сброшенного хода: CAS по sessionId не совпал.
  await emitChannelEvent(
    "action.result",
    { result: {}, sequence: 9, stepIndex: 0, turnId: "turn_old" },
    { chatId, sessionId: "old-session" },
  );

  const after = getChatStatus(key)!;
  assert.equal(after.generation, before.generation);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.sessionId, "live-session");
});

// --- Кнопка ⏹ Стоп в webhook-режиме ---
//
// В штатном long-poll нажатие перехватывает мост (scripts/poller/main.ts зовёт
// handleControl до любой доставки) и до eve оно не доходит. В webhook-режиме моста нет
// вовсе, апдейт идёт прямо в канал — и тогда работает onCallbackQuery. Здесь дёргается
// НАСТОЯЩИЙ вебхук-роут канала: проверяется, что eve доводит колбэк до обработчика, а тот
// зовёт собственный cancel-роут с токеном и turnId из run-status.
const webhookRoute = channel.routes.find(
  (candidate) =>
    candidate.transport !== "websocket" &&
    candidate.method === "POST" &&
    candidate.path === "/eve/v1/telegram",
);
if (!webhookRoute || webhookRoute.transport === "websocket")
  throw new Error("telegramChannel did not expose its webhook route");
const webhookHandler = webhookRoute.handler;

const unusedRouteArg = () => {
  throw new Error("not used by the callback-query path");
};

async function postWebhookUpdate(update: Record<string, unknown>) {
  // Канал подтверждает вебхук раньше диспетчеризации и уводит работу в waitUntil —
  // без дожидания фоновых задач тест увидел бы пустоту.
  const background: Promise<unknown>[] = [];
  const routeSession: Session = {
    id: "webhook-test-session",
    send: unusedRouteArg,
    respond: unusedRouteArg,
    cancel: unusedRouteArg,
    compact: unusedRouteArg,
    clear: unusedRouteArg,
    reset: unusedRouteArg,
    getEventStream: unusedRouteArg,
    getStreamTailIndex: unusedRouteArg,
  };
  const source: ChannelSource<TelegramChannelState> = {
    send: unusedRouteArg,
    respond: (responses) => {
      hitlResponses.push([...responses]);
      return Promise.resolve(routeSession);
    },
    cancel: unusedRouteArg,
    compact: unusedRouteArg,
    clear: unusedRouteArg,
    reset: unusedRouteArg,
  };
  const routeArgs: RouteHandlerArgs<TelegramChannelState> = {
    attachSession: () => routeSession,
    from: () => source,
    resolveSession: () => Promise.resolve(routeSession),
    to: unusedRouteArg,
    params: {},
    waitUntil: (task: Promise<unknown>) => {
      background.push(Promise.resolve(task));
    },
    requestIp: "127.0.0.1",
  };
  const response = await webhookHandler(
    new Request("http://iva.test/eve/v1/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "failure-test-secret",
      },
      body: JSON.stringify(update),
    }),
    routeArgs,
  );
  await Promise.all(background);
  return response;
}

function stopTap(chatId: string, fromId: number, chatType?: string) {
  return {
    update_id: 900 + fromId,
    callback_query: {
      id: `cq-${chatId}`,
      from: { id: fromId, is_bot: false },
      message: {
        message_id: 5,
        date: 1,
        chat: { id: Number(chatId), type: chatType ?? "private" },
      },
      data: "iva_cancel",
    },
  };
}

test("the Stop button reaches the channel's own cancel route when no bridge is running", async () => {
  const chatId = "731";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "webhook-stop-session",
    turnId: "turn_7",
  });
  const before = apiCalls.length;

  await postWebhookUpdate(stopTap(chatId, 9));

  const cancels = callsSince(before, "cancel");
  assert.equal(cancels.length, 1, "нажатие не дошло до cancel-роута");
  assert.deepEqual(cancels[0].body, {
    sessionId: "webhook-stop-session",
    turnId: "turn_7",
  });
  const acks = callsSince(before, "answerCallbackQuery");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].body!.text, "Stopping…");
});

test("Trace: исход «Стопа» ложится в журнал хода", async () => {
  const chatId = "739";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "trace-stop-session",
    turnId: "turn_11",
  });
  const before = traceEvents().length;

  await postWebhookUpdate(stopTap(chatId, 9));

  const stops = traceEvents()
    .slice(before)
    .filter((event) => event.kind === "stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].name, "requested");
  assert.equal(stops[0].turn, "turn_11");
  assert.equal(stops[0].session, "trace-stop-session");
  assert.deepEqual(stops[0].data, { chatKey: key, outcome: "requested" });
});

test("an idle chat and an untrusted tap never reach the cancel route", async () => {
  const idleChat = "732";
  setChatStatus(chatKeyOf(idleChat), { status: "idle" });
  const beforeIdle = apiCalls.length;
  await postWebhookUpdate(stopTap(idleChat, 9));
  assert.equal(callsSince(beforeIdle, "cancel").length, 0);
  assert.equal(
    callsSince(beforeIdle, "answerCallbackQuery")[0].body!.text,
    "Nothing is running right now.",
  );

  const liveChat = "733";
  setChatStatus(chatKeyOf(liveChat), {
    status: "running",
    sessionId: "guarded-session",
    turnId: "turn_8",
  });
  const beforeStranger = apiCalls.length;
  await postWebhookUpdate(stopTap(liveChat, 4242));
  assert.equal(callsSince(beforeStranger, "cancel").length, 0);
  // Спиннер гасим, но чужому нажатию ничего не объясняем.
  const strangerAcks = callsSince(beforeStranger, "answerCallbackQuery");
  assert.equal(strangerAcks.length, 1);
  assert.equal(strangerAcks[0].body!.text, undefined);

  // HITL-колбэк самого eve ("eve:" — TELEGRAM_HITL_CALLBACK_PREFIX) разбирается ДО
  // нашего хука: он не наш, до cancel не доходит, и отвечает на него eve.
  const beforeHitl = apiCalls.length;
  const beforeHitlResponses = hitlResponses.length;
  await postWebhookUpdate({
    ...stopTap(liveChat, 9),
    callback_query: { ...stopTap(liveChat, 9).callback_query, data: "eve:1" },
  });
  assert.equal(callsSince(beforeHitl, "cancel").length, 0);
  assert.equal(callsSince(beforeHitl, "answerCallbackQuery").length, 1);
  assert.equal(hitlResponses.length, beforeHitlResponses + 1);
  assert.equal(hitlResponses.at(-1)?.length, 1);

  // А вот НЕ-HITL чужой колбэк (кнопка меню, долетевшая до eve) попадает уже в наш
  // хук. Само его наличие навсегда закрывает дефолтную ветку eve «Unsupported
  // action.», поэтому спиннер обязан гасить канал — иначе он крутится вечно.
  const beforeForeign = apiCalls.length;
  await postWebhookUpdate({
    ...stopTap(liveChat, 9),
    callback_query: {
      ...stopTap(liveChat, 9).callback_query,
      data: "iva_menu:root",
    },
  });
  assert.equal(callsSince(beforeForeign, "cancel").length, 0);
  const foreignAcks = callsSince(beforeForeign, "answerCallbackQuery");
  assert.equal(foreignAcks.length, 1, "чужой колбэк остался без ack");
  assert.equal(foreignAcks[0].body!.text, undefined);
});

test("non-private webhook Stop callbacks never reach the cancel route", async () => {
  for (const chatType of ["group", "supergroup", "channel"]) {
    const chatId = String(740 + apiCalls.length);
    setChatStatus(chatKeyOf(chatId), {
      status: "running",
      sessionId: `guarded-${String(chatType)}`,
      turnId: "turn_private_boundary",
    });
    const before = apiCalls.length;
    const update = stopTap(chatId, 9, chatType);
    await postWebhookUpdate(update);

    assert.equal(callsSince(before, "cancel").length, 0, String(chatType));
    const acknowledgements = callsSince(before, "answerCallbackQuery");
    assert.equal(acknowledgements.length, 1, String(chatType));
    const text = acknowledgements[0].body?.text;
    if (typeof text !== "string") assert.fail(String(chatType));
    assert.match(text, /private|личн/u, String(chatType));
  }
});

// Состарить запись run-status, не трогая её раскладку: ищем файл по sessionId и
// правим одно поле. Если раскладка изменится, помощник упадёт, а не притворится.
function backdateStatus(sessionId: string, ageMs: number) {
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

// Терминальное событие отмены: ровно такую запись оставляет turn.cancelled канала.
// Без него «Стоп» обязан ждать подтверждения до самого дедлайна.
function finishCancelledTurn(sessionId: unknown) {
  if (typeof sessionId !== "string") return;
  const dir = join(dataDir, "run-status.d");
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      sessionId?: string;
    };
    if (parsed.sessionId !== sessionId) continue;
    writeFileSync(
      file,
      JSON.stringify({
        ...parsed,
        status: "idle",
        sessionId: null,
        turnId: null,
        wasCancelled: true,
        updatedAt: Date.now(),
      }),
    );
    return;
  }
}

test("a crashed turn's stale status still reaches the cancel route in webhook mode", async () => {
  // В webhook-режиме жнеца нет вовсе (он живёт в мосте), поэтому запись «running»
  // после краша процесса лежит вечно. Свежесть записи — не повод молчать: sessionId
  // в ней есть, и отмену надо спросить у eve. Мёртвый ход сам себя выдаст ответом
  // no_active_turn, и только это серверное подтверждение считается «отменять нечего».
  const chatId = "734";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "crashed-session",
    turnId: "turn_9",
  });
  backdateStatus("crashed-session", 31 * 60_000);
  assert.equal(getChatStatus(key)!.status, "running"); // запись всё ещё «идёт»

  const before = apiCalls.length;
  cancelRouteStatus = "no_active_turn";
  try {
    await postWebhookUpdate(stopTap(chatId, 9));
  } finally {
    cancelRouteStatus = "accepted";
  }

  const cancels = callsSince(before, "cancel");
  assert.equal(cancels.length, 1, "нажатие не дошло до cancel-роута");
  assert.deepEqual(cancels[0].body, {
    sessionId: "crashed-session",
    turnId: "turn_9",
  });
  assert.equal(
    callsSince(before, "answerCallbackQuery")[0].body!.text,
    "Nothing is running right now.",
  );
});

test("Trace: ответ модели уходит в журнал ключом своего хода", async () => {
  const chatId = "741";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "trace-outbox-session",
    turnId: "turn_12",
    firstOutputAt: 1,
  });
  const before = traceEvents().length;
  const context = eventContext({
    chatId,
    sessionId: "trace-outbox-session",
  });

  await contextStorage.run(context.ctx, () =>
    adapter["message.completed"](
      {
        finishReason: "stop",
        message: "готово, отпуск в июле",
        sequence: 4,
        stepIndex: 1,
        turnId: "turn_12",
      },
      context.value,
    ),
  );

  const added = traceEvents().slice(before);
  const outbox = added.find((event) => event.kind === "outbox");
  const gate = added.find((event) => event.kind === "gate");
  // Ключ хода и сессия приходят из канала: без них последнее звено цепочки повисло бы.
  assert.equal(outbox?.name, "delivered");
  assert.equal(outbox?.turn, "turn_12");
  assert.equal(outbox?.session, "trace-outbox-session");
  assert.equal(outbox?.source, "telegram");
  assert.equal(gate?.turn, "turn_12");
  assert.equal(
    (gate?.data as Record<string, unknown>).text,
    "готово, отпуск в июле",
  );
});
