/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import test from "node:test";
import assert from "node:assert/strict";
import type { AttachSessionFn } from "eve/channels";
import { requestTelegramCancel } from "#lib/telegram-cancel-client.ts";
import { handleTelegramCancelRequest } from "#lib/telegram-cancel-route.ts";
import { cancelEveTurn } from "#lib/eve-cancel.ts";

type FetchCall = { url: string; init: RequestInit };
type CancelCall = {
  sessionId: string;
  options: { tasks?: boolean; turnId?: string };
};

function cancelHarness(calls: CancelCall[]): AttachSessionFn {
  return ((sessionId: string) => ({
    id: sessionId,
    cancel: async (options: { tasks?: boolean; turnId?: string } = {}) => {
      calls.push({ sessionId, options });
      return { sessionId, status: "accepted" as const };
    },
  })) as AttachSessionFn;
}

test("cancel client sends the session, turn guard and webhook secret", async () => {
  const calls: FetchCall[] = [];
  const result = await requestTelegramCancel({
    url: "http://127.0.0.1/eve/v1/telegram/cancel",
    secret: "secret",
    sessionId: "session-55",
    turnId: "turn-9",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, status: "accepted" });
    },
  });

  assert.equal(result.status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1/eve/v1/telegram/cancel");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)[
      "X-Telegram-Bot-Api-Secret-Token"
    ],
    "secret",
  );
  const requestBody = calls[0]?.init.body;
  if (typeof requestBody !== "string")
    throw new Error("expected string request body");
  assert.deepEqual(JSON.parse(requestBody), {
    sessionId: "session-55",
    turnId: "turn-9",
  });
});

test("cancel client omits an absent turn guard and accepts no_active_turn", async () => {
  const calls: FetchCall[] = [];
  const result = await requestTelegramCancel({
    url: "http://local/cancel",
    secret: "secret",
    sessionId: "session-1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, status: "no_active_turn" });
    },
  });

  assert.equal(result.status, "no_active_turn");
  const requestBody = calls[0]?.init.body;
  if (typeof requestBody !== "string")
    throw new Error("expected string request body");
  assert.deepEqual(JSON.parse(requestBody), { sessionId: "session-1" });
});

test("cancel client rejects HTTP and malformed success responses", async () => {
  await assert.rejects(
    requestTelegramCancel({
      url: "http://local/cancel",
      secret: "secret",
      sessionId: "session-1",
      fetchImpl: async () => new Response("failed", { status: 500 }),
    }),
    /HTTP 500/u,
  );
  await assert.rejects(
    requestTelegramCancel({
      url: "http://local/cancel",
      secret: "secret",
      sessionId: "session-1",
      fetchImpl: async () => Response.json({ ok: true, status: "reset" }),
    }),
    /invalid response/u,
  );
});

test("cancel route authenticates and forwards the exact session and turn", async () => {
  const calls: CancelCall[] = [];
  const response = await handleTelegramCancelRequest(
    new Request("http://local/eve/v1/telegram/cancel", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ sessionId: "session-55", turnId: "turn-9" }),
    }),
    cancelHarness(calls),
    "secret",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-55",
    status: "accepted",
  });
  assert.deepEqual(calls, [
    { sessionId: "session-55", options: { tasks: true, turnId: "turn-9" } },
  ]);
});

test("cancel route rejects bad auth and bad input before cancelling", async () => {
  const calls: CancelCall[] = [];
  const attach = cancelHarness(calls);
  const request = (body: string, secret = "secret") =>
    new Request("http://local/cancel", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body,
    });

  assert.equal(
    (
      await handleTelegramCancelRequest(
        request('{"sessionId":"s"}', "bad"),
        attach,
        "secret",
      )
    ).status,
    401,
  );
  assert.equal(
    (await handleTelegramCancelRequest(request("{ not json"), attach, "secret"))
      .status,
    400,
  );
  assert.equal(
    (await handleTelegramCancelRequest(request("{}"), attach, "secret")).status,
    400,
  );
  assert.equal(
    (
      await handleTelegramCancelRequest(
        request('{"sessionId":"s","turnId":""}'),
        attach,
        "secret",
      )
    ).status,
    400,
  );
  assert.deepEqual(calls, []);
});

test("the whole Stop path reaches eve through the fixed session handle", async () => {
  const calls: CancelCall[] = [];
  const result = await requestTelegramCancel({
    url: "http://127.0.0.1:8723/eve/v1/telegram/cancel",
    secret: "webhook-secret",
    sessionId: "session-1",
    turnId: "turn-1",
    fetchImpl: (url, init) =>
      handleTelegramCancelRequest(
        new Request(url, init),
        cancelHarness(calls),
        "webhook-secret",
      ),
  });

  assert.equal(result.status, "accepted");
  assert.deepEqual(calls, [
    { sessionId: "session-1", options: { tasks: true, turnId: "turn-1" } },
  ]);
});

test("the cancel adapter omits an absent turn guard", async () => {
  const calls: CancelCall[] = [];
  const attach = cancelHarness(calls);
  await cancelEveTurn(attach, { sessionId: "session-1" });
  await cancelEveTurn(attach, { sessionId: "session-1", turnId: "turn-2" });

  assert.deepEqual(calls, [
    { sessionId: "session-1", options: { tasks: true } },
    { sessionId: "session-1", options: { tasks: true, turnId: "turn-2" } },
  ]);
  assert.equal("turnId" in calls[0].options, false);
});
