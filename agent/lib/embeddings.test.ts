/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Отмена хода доезжает до эмбеддингов: каждый батч — отдельный платный запрос, и сигнал
// обязан прекращать цикл, а не только текущий fetch. В сеть тест не ходит: fetch подменён.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MEMORY_EMBED_URL = "http://127.0.0.1:9/v1/embeddings";
delete process.env.JINA_API_KEY;
delete process.env.DEEPINFRA_API_KEY;

const { embedTexts } = await import("./embeddings.ts");

function vectorResponse(input: string[]): Response {
  return new Response(
    JSON.stringify({ data: input.map(() => ({ embedding: [1, 0, 0, 0] })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function requestedInput(init: { body?: unknown } | undefined): string[] {
  return (JSON.parse(init?.body as string) as { input: string[] }).input;
}

test("каждый батч уходит с сигналом хода", async () => {
  const controller = new AbortController();
  const batches: string[][] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => {
    batches.push(requestedInput(init));
    signals.push(init?.signal);
    return Promise.resolve(vectorResponse(requestedInput(init)));
  };
  try {
    const vectors = await embedTexts(["a", "b", "c"], {
      batchSize: 2,
      signal: controller.signal,
    });
    assert.deepEqual(batches, [["a", "b"], ["c"]]);
    assert.deepEqual(signals, [controller.signal, controller.signal]);
    assert.equal(vectors.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("отмена между батчами прекращает цикл", async () => {
  const controller = new AbortController();
  const batches: string[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => {
    const input = requestedInput(init);
    batches.push(input);
    controller.abort(); // отмена приходит ровно на границе батчей
    return Promise.resolve(vectorResponse(input));
  };
  try {
    await assert.rejects(
      embedTexts(["a", "b", "c"], { batchSize: 1, signal: controller.signal }),
      /abort/i,
    );
    assert.deepEqual(batches, [["a"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
