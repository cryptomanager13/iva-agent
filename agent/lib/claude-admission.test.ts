/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Реле допуска: один POST /v1/messages уходит на api.anthropic.com, второй получает 400.
// api.anthropic.com подменён loopback-заглушкой: проверяется перевод, а не чужая сеть. Ответ
// стримится как SSE — реле обязано и отдать байты CLI, и запомнить из них сообщение модели.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { startAdmission, type Admission } from "./claude-admission.ts";

const USAGE = {
  input_tokens: 100,
  cache_read_input_tokens: 40,
  cache_creation_input_tokens: 5,
  output_tokens: 12,
};

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** События настоящего ответа: текст, вызов инструмента из дельт и завершение. */
function answerEvents(): unknown[] {
  return [
    {
      type: "message_start",
      message: { id: "msg_1", content: [], usage: USAGE },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "При" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "вет" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "mcp__iva__weather",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"Таш' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'кент"}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  ];
}

type Fixture = {
  readonly url: string;
  readonly requests: IncomingMessage[];
  readonly bodies: string[];
  readonly sockets: number;
  respond(events: unknown[]): void;
  close(): Promise<void>;
};

/** Заглушка api.anthropic.com: отвечает заранее заготовленными событиями. */
async function fakeUpstream(
  t: TestContext,
  options: { status?: number; split?: boolean } = {},
): Promise<Fixture> {
  const requests: IncomingMessage[] = [];
  const bodies: string[] = [];
  let open = 0;
  const pending: ((events: unknown[]) => void)[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(body);
      const status = options.status ?? 200;
      response.writeHead(status, {
        "content-type": "text/event-stream",
        "x-request-id": "req_test",
        ...(status === 200 ? {} : { "x-error": "bad" }),
      });
      if (status !== 200) {
        response.end("nope");
        return;
      }
      const write = (events: unknown[]): void => {
        const bodyText = sse(events);
        if (options.split !== true) {
          response.end(bodyText);
          return;
        }
        response.write(bodyText.slice(0, 40));
        setTimeout(() => response.end(bodyText.slice(40)), 20);
      };
      if (options.split === true && pending.length >= 0) {
        pending.push(write);
        setTimeout(() => {
          if (pending.includes(write)) write(answerEvents());
        }, 5);
        return;
      }
      write(answerEvents());
    });
  });
  server.on("connection", () => {
    open += 1;
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    bodies,
    get sockets() {
      return open;
    },
    respond: (events) => {
      for (const write of pending.splice(0)) write(events);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function post(
  admission: Admission,
  path = "/v1/messages",
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${admission.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "claude-fable-5-1", stream: true }),
  });
}

test("первый запрос уходит на api.anthropic.com с заголовками CLI", async (t) => {
  const upstream = await fakeUpstream(t);
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());

  const response = await post(admission, "/v1/messages", {
    authorization: "Bearer subscription-token",
    "x-app": "cli",
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes("message_stop"), "ответ возвращается целиком");

  const [request] = upstream.requests;
  assert.ok(request !== undefined);
  assert.equal(request.method, "POST");
  // Путь на api.anthropic.com — его собственный, а не наш префикс допуска.
  assert.equal(request.url, "/v1/messages");
  assert.equal(request.headers.authorization, "Bearer subscription-token");
  assert.equal(request.headers["x-app"], "cli");
  // identity: сжатие сломало бы и разбор SSE, и поток байт обратно в CLI.
  assert.equal(request.headers["accept-encoding"], "identity");
  assert.equal(request.headers.host, new URL(upstream.url).host);
  assert.equal(upstream.bodies.length, 1);
});

test("ответ запоминается: блоки, склейка input_json_delta и расход", async (t) => {
  const upstream = await fakeUpstream(t);
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());

  await (await post(admission)).text();
  assert.equal(admission.used, true);
  assert.equal(admission.status, 200);
  assert.equal(admission.capture.complete, true);
  assert.deepEqual(admission.capture.message, {
    id: "msg_1",
    content: [
      { type: "text", text: "Привет" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "mcp__iva__weather",
        input: { city: "Ташкент" },
      },
    ],
    usage: { ...USAGE },
    stop_reason: "tool_use",
  });
});

test("разрезанный по сети ответ собирается так же", async (t) => {
  const upstream = await fakeUpstream(t, { split: true });
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());
  await (await post(admission)).text();
  assert.equal(admission.capture.complete, true);
  assert.equal(admission.capture.message?.stop_reason, "tool_use");
});

// CLI 2.1.278 дописывает к адресу строку запроса (`?beta=true`) и первым делом стучится в
// `HEAD <префикс>/api/hello`. Строгое сравнение с `?beta=true` отдавало 404, а 404 от шлюза
// CLI читает как «такой модели нет или нет доступа» и в API не идёт вовсе — то есть ход
// умирал, не начавшись (живая проверка 22.09.2026).
test("запрос со строкой запроса — это тот же путь, и она уезжает наверх", async (t) => {
  const upstream = await fakeUpstream(t);
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());

  const response = await post(admission, "/v1/messages?beta=true");
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(admission.used, true);
  assert.equal(upstream.requests[0]?.url, "/v1/messages?beta=true");
  assert.equal(admission.capture.complete, true);
});

test("второй запрос получает 400 с именем причины и наружу не уходит", async (t) => {
  const upstream = await fakeUpstream(t);
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());

  await (await post(admission)).text();
  const second = await post(admission);
  assert.equal(second.status, 400);
  assert.deepEqual(await second.json(), {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "IVA_MODEL_ADMISSION_CONSUMED",
    },
  });
  assert.equal(admission.denied, 1);
  assert.equal(
    upstream.bodies.length,
    1,
    "второго похода к api.anthropic.com нет",
  );
  // Запомненный ответ после отказа не портится.
  assert.equal(admission.capture.complete, true);
});

test("чужие пути и методы реле не обслуживает", async (t) => {
  const upstream = await fakeUpstream(t);
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());

  // Без случайного префикса пути — как будто кто-то нашёл порт и стучится наугад.
  const origin = new URL(admission.url).origin;
  const stray = await fetch(`${origin}/v1/messages`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(stray.status, 404);
  assert.equal((await post(admission, "/v2/messages")).status, 404);
  const get = await fetch(admission.url, { method: "GET" });
  assert.equal(get.status, 404);
  // Origin ставит браузер, а не CLI: со страницы, угадавшей порт и путь, ход не начинают —
  // иначе открытая вкладка тратила бы подписку владельца его же токеном.
  const page = await fetch(`${admission.url}/v1/messages`, {
    method: "POST",
    headers: { origin: "https://example.com" },
    body: "{}",
  });
  assert.equal(page.status, 404);
  assert.equal(admission.used, false);
  assert.equal(upstream.bodies.length, 0);
});

test("abort рвёт оба сокета: и нашего клиента, и поход наружу", async (t) => {
  let upstreamClosed = false;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      sse([{ type: "message_start", message: { id: "m", content: [] } }]),
    );
    response.on("close", () => {
      upstreamClosed = true;
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as AddressInfo;
  const admission = await startAdmission(
    `http://127.0.0.1:${address.port}`,
    5_000,
  );
  t.after(() => admission.close());

  const response = await post(admission);
  assert.equal(response.status, 200);
  admission.abort();
  await assert.rejects(async () => {
    // Поток уже открыт: чтение тела обязано упасть, а не ждать тишины.
    await response.text();
  });
  await waitFor(() => upstreamClosed);
  assert.equal(upstreamClosed, true, "сокет наружу оборван отменой");
  // После отмены реле отвечает отказом допуска: ход уже кончился, и новый запрос — чужой.
  const afterAbort = await post(admission);
  assert.equal(afterAbort.status, 400);
});

test("заголовки CLI не попадают в журнал", async (t) => {
  const upstream = await fakeUpstream(t);
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());
  const logged: unknown[][] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...args: unknown[]) => logged.push(args);
  console.log = (...args: unknown[]) => logged.push(args);
  try {
    await (
      await post(admission, "/v1/messages", {
        authorization: "Bearer super-secret-token",
      })
    ).text();
  } finally {
    console.error = realError;
    console.log = realLog;
  }
  assert.deepEqual(logged, [], "подписочный токен в журнал не уезжает");
});

test("ответ не 200 не считается сообщением модели", async (t) => {
  const upstream = await fakeUpstream(t, { status: 500 });
  const admission = await startAdmission(upstream.url, 5_000);
  t.after(() => admission.close());

  const response = await post(admission);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "nope");
  assert.equal(admission.status, 500);
  assert.equal(admission.capture.complete, false);
  assert.equal(admission.capture.message, null);
});

test("обрыв ответа на середине не выдаётся за целое сообщение", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = answerEvents().slice(0, 4);
    response.end(sse(events));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as AddressInfo;
  const admission = await startAdmission(
    `http://127.0.0.1:${address.port}`,
    5_000,
  );
  t.after(() => admission.close());

  await (await post(admission)).text();
  assert.equal(admission.capture.complete, false);
  assert.equal(admission.capture.message?.stop_reason, undefined);
});

test("адрес api.anthropic.com обязан быть HTTPS или loopback", async () => {
  await assert.rejects(
    () => startAdmission("http://api.anthropic.com", 1_000),
    /must be https/u,
  );
  await assert.rejects(
    () => startAdmission("ftp://api.anthropic.com", 1_000),
    /must be https/u,
  );
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
