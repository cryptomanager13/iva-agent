/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// В hybrid-режиме memory_search ходит в сеть за эмбеддингом запроса. Отменённый ход в сеть
// не идёт вовсе, а живой отдаёт сигнал в fetch — сеть подменена, сервер-заглушка не нужна.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT = mkdtempSync(join(tmpdir(), "iva-memsearch-abort-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.MEMORY_SEARCH_MODE = "hybrid";
process.env.MEMORY_EMBED_URL = "http://127.0.0.1:9/v1/embeddings";
mkdirSync(join(VAULT, "cards"), { recursive: true });
mkdirSync(join(VAULT, ".index"), { recursive: true });
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

writeFileSync(
  join(VAULT, "cards", "ivan.md"),
  "---\ntype: contact\nname: Иван Петров\nstatus: active\n---\n\n" +
    "# Иван Петров\n\nПодрядчик по монтажу.\n",
);
// Dense-половина ищет только по сайдкар-индексу: без него запроса к эмбеддингам нет вовсе.
writeFileSync(
  join(VAULT, ".index", "embeddings.json"),
  JSON.stringify({ model: "stub", vectors: { "cards/ivan.md": [1, 0, 0, 0] } }),
);

const { searchMemory } = await import("../agent/tools/memory_search.ts");

function vectorResponse(): Response {
  return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), {
    status: 200,
  });
}

test("отменённый ход не уходит в сеть за эмбеддингами", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    throw new Error("сеть при отменённом ходе запрещена");
  };
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await searchMemory(
      { query: "монтаж" },
      { abortSignal: controller.signal },
    );
    assert.equal(requests, 0);
    assert.equal(result.error, undefined);
    assert.ok(result.hits.some((hit) => hit.file === "cards/ivan.md"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("живой ход отдаёт сигнал в fetch и сливает dense с BM25", async () => {
  const originalFetch = globalThis.fetch;
  const signals: (AbortSignal | null | undefined)[] = [];
  globalThis.fetch = (_url, init) => {
    signals.push(init?.signal);
    return Promise.resolve(vectorResponse());
  };
  const controller = new AbortController();
  try {
    const result = await searchMemory(
      { query: "монтаж" },
      { abortSignal: controller.signal },
    );
    assert.deepEqual(signals, [controller.signal]);
    assert.equal(result.engine, "hybrid-rrf");
    assert.ok(result.hits.some((hit) => hit.file === "cards/ivan.md"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
