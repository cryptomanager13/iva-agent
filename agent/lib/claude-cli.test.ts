/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Модель claude проверяется на поддельном CLI: настоящий `claude` ходил бы в api.anthropic.com
// подписочным токеном владельца, а проверять надо ПЕРЕВОД, а не чужую сеть. Подделка — это
// node-скрипт, который говорит на том же stream-json: подтверждает переигрывание истории
// `result num_turns:0`, отвечает на последний кадр и умеет ломаться так, как ломается настоящий
// CLI (ошибка API в assistant, обрыв без result, тишина, отказ на инструмент вне списка).
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { classifyModelCallError } from "../../node_modules/eve/dist/src/harness/model-call-error.js";

// Свой TMPDIR на файл: тест «временная папка уходит раньше» считает папки iva-claude-* в
// tmpdir(), а pre-push гоняет файлы параллельно — чужой ход с тем же префиксом в общем /tmp
// делал его красным без дефекта. os.tmpdir() читает TMPDIR на каждом вызове.
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), "iva-claude-cli-test-"));
process.env.TMPDIR = PRIVATE_TMP;
process.on("exit", () => rmSync(PRIVATE_TMP, { recursive: true, force: true }));
import {
  CLAUDE_SILENCE_TIMEOUT_MS,
  claudeModel,
  claudeNativeModel,
  CLAUDE_TOOL_PREFIX,
  ClaudeCliError,
  claudeCommand,
  claudeConflicts,
  claudeEffort,
  claudeEnv,
  claudeExtraBody,
  claudeTools,
  claudeUsage,
  claudeWarnings,
  makeClaudeCliModel,
  readCompletion,
} from "./claude-cli.ts";

// ─── Поддельный CLI ─────────────────────────────────────────────────────────────────────
// Сценарий выбирается FAKE_CLAUDE_MODE, а всё, что ему дали на входе (argv, settings.json,
// system.md и полученные кадры), он кладёт в FAKE_CLAUDE_DUMP: тест проверяет не только ответ,
// но и то, что уехало в CLI.
const FAKE_CLI = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const mode = process.env.FAKE_CLAUDE_MODE ?? "text";
const dumpPath = process.env.FAKE_CLAUDE_DUMP;
const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"));
const frames = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const message = (content, stop, usage) => ({ role: "assistant", content, stop_reason: stop, usage });
const textBlock = (text) => ({ type: "text", text });
const usage = { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 };

function streamText(chunks) {
  send({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } });
  send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: textBlock("") } });
  for (const chunk of chunks)
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } } });
  send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
}

function dump(extra) {
  if (dumpPath === undefined) return;
  writeFileSync(dumpPath, JSON.stringify({ argv, settings, system: readFileSync(arg("--system-prompt-file"), "utf8"), frames, pid: process.pid, ...extra }));
}

async function scenario() {
  if (mode === "relay" || mode === "relay-mismatch") {
    // Подделка ходит в реле так же, как настоящий CLI: POST на ANTHROPIC_BASE_URL с query,
    // своими заголовками (в том числе секретным) и без ожидания второго ответа.
    const answer = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (process.env.FAKE_CLAUDE_TOKEN ?? "") },
      body: JSON.stringify({ model: arg("--model"), stream: true, messages: [{ role: "user", content: "привет" }] }),
    });
    const body = await answer.text();
    const received = body
      .split("\\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .filter((event) => event.delta?.type === "text_delta")
      .map((event) => event.delta.text)
      .join("");
    const printed = mode === "relay-mismatch" ? "другой ответ" : (process.env.FAKE_CLAUDE_PRINT ?? received);
    // Второй поход — то, что настоящий CLI делает сам, чтобы дописать ход за eve. Реле его
    // отбивает, CLI объявляет ошибку API и выходит единицей: ровно так ведёт себя Fable.
    let second = null;
    if (process.env.FAKE_CLAUDE_SECOND === "1") {
      const retry = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: arg("--model"), stream: true, messages: [] }),
      });
      second = { status: retry.status, body: await retry.text() };
    }
    dump({ answer: answer.status, second, received, printed, fallback: process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK });
    streamText([printed]);
    send({ type: "assistant", message: message([textBlock(printed)], "end_turn", { input_tokens: 999, output_tokens: 999 }) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    if (second !== null) {
      send({ type: "assistant", error: { type: "api_error" }, message: message([textBlock("API Error: 400 " + second.body)], "end_turn", {}) });
      send({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage: {} });
      process.exit(1);
    }
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: { input_tokens: 999, output_tokens: 999 } });
    process.exit(0);
  }
  if (mode === "script") {
    // Сценарий по шагам: событие CLI как есть или пауза. С FAKE_CLAUDE_RELAY=1 подделка сначала
    // сходит в реле, как настоящий CLI, и печатает сценарий уже после ответа API.
    if (process.env.FAKE_CLAUDE_RELAY === "1") {
      const answer = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: arg("--model"), stream: true, messages: [] }),
      });
      await answer.text();
    }
    dump({});
    for (const step of JSON.parse(process.env.FAKE_CLAUDE_SCRIPT)) {
      if (typeof step.pause === "number") await new Promise((resolve) => setTimeout(resolve, step.pause));
      else send(step);
    }
    const code = Number(process.env.FAKE_CLAUDE_EXIT ?? "0");
    const linger = process.env.FAKE_CLAUDE_LINGER_MS;
    if (linger === undefined) process.exit(code);
    // Вывод закрыт, а процесс ещё жив: так шаг ждёт выхода CLI после конца его вывода.
    process.stdout.write("", () => {
      closeSync(1);
      setTimeout(() => process.exit(code), Number(linger));
    });
    return;
  }
  if (mode === "text") {
    dump({});
    // Причина остановки и расход самого CLI задаются снаружи: без реле шаг верит его итогу,
    // и разойтись эти два числа должны именно в тесте.
    const stop = process.env.FAKE_CLAUDE_STOP ?? "end_turn";
    const own = process.env.FAKE_CLAUDE_ASSISTANT_USAGE;
    streamText(["Го", "тово"]);
    send({ type: "assistant", message: message([textBlock("Готово")], stop, own === undefined ? usage : JSON.parse(own)) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
    process.exit(0);
  }
  if (mode === "long") {
    dump({});
    streamText(["a".repeat(4000)]);
    const text = "a".repeat(4000);
    send({ type: "assistant", message: message([textBlock(text)], "end_turn", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
    process.exit(0);
  }
  if (mode === "tool") {
    dump({});
    const calls = [
      { type: "tool_use", id: "toolu_1", name: "mcp__iva__weather", input: { city: "Ташкент" } },
      { type: "tool_use", id: "toolu_2", name: "mcp__iva__remind", input: { action: "list" } },
    ];
    streamText(["Сейчас "]);
    send({ type: "assistant", message: message([textBlock("Сейчас "), ...calls], "tool_use", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, usage });
    process.exit(1);
  }
  if (mode === "foreign-tool") {
    dump({});
    send({ type: "assistant", message: message([{ type: "tool_use", id: "toolu_9", name: "Bash", input: {} }], "tool_use", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, usage });
    process.exit(1);
  }
  if (mode === "api-error") {
    dump({});
    send({ type: "assistant", error: { type: "api_error" }, message: message([textBlock("API Error: 500 internal server error")], "end_turn", usage) });
    send({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage });
    process.exit(1);
  }
  if (mode === "truncated") {
    dump({});
    streamText(["Обры"]);
    send({ type: "assistant", message: message([textBlock("Обрыв")], "end_turn", usage) });
    process.exit(0);
  }
  if (mode === "exit-noise") {
    dump({});
    streamText(["Ответ"]);
    send({ type: "assistant", message: message([textBlock("Ответ")], "end_turn", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
    process.exit(7);
  }
  if (mode === "silent") {
    dump({});
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "slow") {
    dump({});
    const every = Number(process.env.FAKE_CLAUDE_INTERVAL_MS ?? "100");
    const total = Number(process.env.FAKE_CLAUDE_EVENTS ?? "4");
    let sent = 0;
    streamText([]);
    const tick = setInterval(() => {
      sent += 1;
      send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } });
      if (sent < total) return;
      clearInterval(tick);
      send({ type: "assistant", message: message([textBlock("x".repeat(total))], "end_turn", usage) });
      send({ type: "stream_event", event: { type: "message_stop" } });
      send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
      process.exit(0);
    }, every);
    return;
  }
  if (mode === "mcp") {
    // Муляж MCP проверяется по-настоящему: подделка CLI запускает его так, как это делает CLI.
    const config = JSON.parse(arg("--mcp-config"));
    const server = config.mcpServers.iva;
    const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
    const ask = (row) => { child.stdin.write(JSON.stringify(row) + "\\n"); };
    let buffer = "";
    const answers = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end = buffer.indexOf("\\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        answers.push(JSON.parse(line));
        end = buffer.indexOf("\\n");
        if (answers.length === 4) finish();
      }
    });
    const finish = () => {
      child.kill("SIGKILL");
      const text = JSON.stringify(answers.map((row) => row.result));
      dump({ mcp: answers });
      streamText([text]);
      send({ type: "assistant", message: message([textBlock(text)], "end_turn", usage) });
      send({ type: "stream_event", event: { type: "message_stop" } });
      send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
      process.exit(0);
    };
    ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "weather" } });
    ask({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    return;
  }
  dump({});
  process.exit(3);
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\\n");
    if (end < 0) return;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.trim() === "") continue;
    const frame = JSON.parse(line);
    frames.push(frame);
    if (frame.shouldQuery === false) {
      send({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage: {} });
      continue;
    }
    if (frame.type === "user") void scenario();
  }
});
`;
const WEATHER: LanguageModelV4FunctionTool = {
  type: "function",
  name: "weather",
  description: "Погода в городе",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const MODEL = "claude-fable-5-1";

type Fake = {
  readonly command: string;
  readonly dump: string;
  read(): Record<string, unknown>;
};

/** Ставит подделку в PATH-независимый CLAUDE_COMMAND и убирает за собой env и файлы. */
function fakeCli(
  t: TestContext,
  mode: string,
  env: Record<string, string> = {},
): Fake {
  const dir = mkdtempSync(join(tmpdir(), "iva-fake-claude-"));
  const command = join(dir, "fake-claude.mjs");
  writeFileSync(command, FAKE_CLI);
  chmodSync(command, 0o755);
  const dump = join(dir, "dump.json");
  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string): void => {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  };
  set("CLAUDE_COMMAND", command);
  set("FAKE_CLAUDE_MODE", mode);
  set("FAKE_CLAUDE_DUMP", dump);
  for (const [key, value] of Object.entries(env)) set(key, value);
  t.after(() => {
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    command,
    dump,
    read: () =>
      JSON.parse(readFileSync(dump, "utf8")) as Record<string, unknown>,
  };
}

// ─── Заглушка api.anthropic.com ─────────────────────────────────────────────────────────
// Реле пересылает шаг наружу, и на верёвочке из двух подделок (CLI + API) видно то, что в бою
// не видно глазами: расход и блоки берутся из ПОЙМАННОГО ответа, а не из рассказа CLI о нём.

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Ответ Anthropic: текст двумя дельтами, вызов инструмента и расход в двух местах. */
function relayAnswer(text: string): string[] {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_relay",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 11,
          cache_creation_input_tokens: 800,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, 11) },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(11) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_relay",
        name: `${CLAUDE_TOOL_PREFIX}weather`,
        input: {},
      },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"Ташкент"}' },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        output_tokens: 12,
        output_tokens_details: { thinking_tokens: 5 },
      },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

/** Что заглушка API увидела от реле: адрес запроса и заголовки хода. */
type SeenRequest = {
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly acceptEncoding: string | undefined;
  readonly transferEncoding: string | undefined;
  readonly contentLength: string | undefined;
  /** Длина тела, которое заглушка прочитала: с ней сверяется объявленная длина. */
  readonly body: number;
};

/** Поднимает заглушку API: адрес получает реле как upstream, запросы — тест. */
async function stubApi(
  t: TestContext,
  events: readonly string[],
): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        acceptEncoding: request.headers["accept-encoding"],
        transferEncoding: request.headers["transfer-encoding"],
        contentLength: request.headers["content-length"],
        body: Buffer.concat(chunks).length,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(event);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, seen };
}

/** Временные папки хода: по ним видно, поднимались ли процесс и реле. */
function tempDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("iva-claude-"))
    .sort();
}

/** Так ход снимает eve: `TurnCancelledError` в причине сигнала (harness/turn-cancellation). */
function cancellation(): Error {
  const error = new Error("The turn was cancelled.");
  error.name = "TurnCancelledError";
  return error;
}

function userPrompt(text = "привет"): LanguageModelV4Prompt {
  return [
    { role: "system", content: "Ты Ива." },
    { role: "user", content: [{ type: "text", text }] },
  ];
}

function replayPrompt(): LanguageModelV4Prompt {
  return [
    { role: "system", content: "Ты Ива." },
    { role: "user", content: [{ type: "text", text: "меня зовут Шима" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "думаю" },
        { type: "text", text: "Приятно познакомиться." },
        {
          type: "tool-call",
          toolCallId: "toolu_old",
          toolName: "weather",
          input: '{"city":"Ташкент"}',
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_old",
          toolName: "weather",
          output: { type: "text", value: "+30" },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "а завтра?" }] },
  ];
}

async function drain(
  result: LanguageModelV4StreamResult,
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done === true) return parts;
    parts.push(next.value);
  }
}

function partsOfType<T extends LanguageModelV4StreamPart["type"]>(
  parts: readonly LanguageModelV4StreamPart[],
  type: T,
): Extract<LanguageModelV4StreamPart, { type: T }>[] {
  return parts.filter(
    (part): part is Extract<LanguageModelV4StreamPart, { type: T }> =>
      part.type === type,
  );
}

function textOf(parts: readonly LanguageModelV4StreamPart[]): string {
  return partsOfType(parts, "text-delta")
    .map((part) => part.delta)
    .join("");
}

function finishOf(parts: readonly LanguageModelV4StreamPart[]) {
  const finishes = partsOfType(parts, "finish");
  assert.equal(finishes.length, 1, "ровно одна причина остановки на шаг");
  return finishes[0];
}

async function failureOf(
  run: () => Promise<unknown>,
): Promise<Error & { name: string }> {
  let caught: unknown;
  await assert.rejects(run, (error: unknown) => {
    caught = error;
    return error instanceof Error;
  });
  assert.ok(caught instanceof Error);
  return caught;
}

// ─── Сценарий CLI по шагам ──────────────────────────────────────────────────────────────
// Режим script печатает события, которые дал тест, с паузами между ними: так видно, КОГДА
// часть шага уходит наружу, а не только какой она была.

type ScriptStep = Record<string, unknown>;

const STEP_USAGE = { input_tokens: 11, output_tokens: 4 };
const MESSAGE_START = streamEvent({
  type: "message_start",
  message: { id: "msg_1" },
});
const MESSAGE_STOP = streamEvent({ type: "message_stop" });
function streamEvent(event: Record<string, unknown>): ScriptStep {
  return { type: "stream_event", event };
}

function blockStart(index: number, block: Record<string, unknown>): ScriptStep {
  return streamEvent({
    type: "content_block_start",
    index,
    content_block: block,
  });
}

function blockDelta(index: number, delta: Record<string, unknown>): ScriptStep {
  return streamEvent({ type: "content_block_delta", index, delta });
}

function blockStop(index: number): ScriptStep {
  return streamEvent({ type: "content_block_stop", index });
}

function assistantSays(
  content: Record<string, unknown>[],
  stop = "tool_use",
): ScriptStep {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content,
      stop_reason: stop,
      usage: STEP_USAGE,
    },
  };
}

function scriptCli(
  t: TestContext,
  steps: readonly ScriptStep[],
  env: Record<string, string> = {},
): Fake {
  return fakeCli(t, "script", {
    FAKE_CLAUDE_SCRIPT: JSON.stringify(steps),
    ...env,
  });
}

// ─── Нормальный ход ─────────────────────────────────────────────────────────────────────

test("текст, расход и причина остановки доезжают из ответа CLI", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  const parts = await drain(await model.doStream({ prompt: userPrompt() }));

  assert.equal(textOf(parts), "Готово");
  assert.deepEqual(
    parts.map((part) => part.type),
    [
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ],
  );
  const finish = finishOf(parts);
  assert.deepEqual(finish.finishReason, { unified: "stop", raw: "end_turn" });
  // Расход — из настоящего ответа: total включает кэш, cache-read и cache-write отдельными полями.
  assert.deepEqual(finish.usage.inputTokens, {
    total: 16,
    noCache: 11,
    cacheRead: 3,
    cacheWrite: 2,
  });
  assert.equal(finish.usage.outputTokens.total, 4);
  // Счётчик реле: запроса к api.anthropic.com не было — подделка в сеть не ходит.
  assert.equal(
    (finish.providerMetadata?.["iva-claude"] as { upstreamRequests?: number })
      ?.upstreamRequests,
    0,
  );

  const dump = fake.read();
  assert.equal(dump.system, "Ты Ива.");
  const settings = dump.settings as {
    env: { CLAUDE_CODE_EXTRA_BODY: string };
  };
  assert.deepEqual(JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY), {
    tools: [],
    thinking: { type: "adaptive" },
  });
});

test("инструменты уезжают в тело запроса с префиксом муляжа MCP", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  await drain(await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }));
  const settings = fake.read().settings as {
    env: { CLAUDE_CODE_EXTRA_BODY: string };
  };
  const body = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY) as {
    tools: unknown;
  };
  assert.deepEqual(body.tools, [
    {
      name: `${CLAUDE_TOOL_PREFIX}weather`,
      description: "Погода в городе",
      input_schema: WEATHER.inputSchema,
    },
  ]);
  const argv = fake.read().argv as string[];
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(argv[argv.indexOf("--max-turns") + 1], "1");
  assert.equal(
    argv[argv.indexOf("--model") + 1],
    "claude-fable-5-1[1m]",
    "CLI принимает своё имя модели, а не route-ид",
  );
  const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}") as {
    mcpServers: { iva: { command: string; args: string[] } };
  };
  assert.equal(mcp.mcpServers.iva.command, process.execPath);
  assert.equal(mcp.mcpServers.iva.args[0], "-e");
});

test("история уезжает кадрами: переигрывание помечено, рассуждение не переигрывается", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  await drain(
    await model.doStream({ prompt: replayPrompt(), tools: [WEATHER] }),
  );
  const frames = fake.read().frames as {
    type: string;
    shouldQuery?: boolean;
    message: { role: string; content: { type: string; name?: string }[] };
  }[];
  assert.deepEqual(
    frames.map((frame) => [frame.type, frame.shouldQuery]),
    [
      ["user", false],
      ["assistant", undefined],
      ["user", undefined],
    ],
    "все кадры истории, кроме последнего запроса, помечены shouldQuery:false",
  );
  const assistant = frames[1];
  assert.deepEqual(
    assistant.message.content.map((block) => block.type),
    ["text", "tool_use"],
    "рассуждение в историю не возвращается",
  );
  const result = frames[2].message.content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(
    frames[2].message.content.length,
    2,
    "результат инструмента и следующий вопрос склеены в один user-кадр",
  );
});

test("муляж MCP отдаёт список инструментов и отказывается их исполнять", async (t) => {
  fakeCli(t, "mcp");
  const model = makeClaudeCliModel(MODEL);
  const parts = await drain(
    await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );
  const [initialized, listed, called, unknown] = JSON.parse(textOf(parts)) as {
    tools?: { name: string }[];
    isError?: boolean;
    content?: { text: string }[];
  }[];
  assert.equal(initialized?.tools, undefined, "initialize без инструментов");
  assert.deepEqual(listed?.tools, [
    {
      name: "weather",
      description: "Погода в городе",
      inputSchema: WEATHER.inputSchema,
    },
  ]);
  assert.equal(called?.isError, true);
  assert.match(String(called?.content?.[0]?.text), /Denied/u);
  // Отказ — только на исполнение. Незнакомый метод (CLI спрашивает и про ресурсы, и про
  // промпты) получает пустой ответ: объявлять ошибкой то, чего у нас просто нет, незачем.
  assert.deepEqual(unknown, {});
});

// ─── Инструменты и границы хода ─────────────────────────────────────────────────────────

test("tool_use и error_max_turns с кодом 1 — штатный конец хода", async (t) => {
  fakeCli(t, "tool");
  const model = makeClaudeCliModel(MODEL);
  const parts = await drain(
    await model.doStream({
      prompt: userPrompt(),
      tools: [
        WEATHER,
        { ...WEATHER, name: "remind", description: "Напоминания" },
      ],
    }),
  );
  assert.deepEqual(
    partsOfType(parts, "tool-call").map((part) => [
      part.toolName,
      part.toolCallId,
      part.input,
    ]),
    [
      ["weather", "toolu_1", '{"city":"Ташкент"}'],
      ["remind", "toolu_2", '{"action":"list"}'],
    ],
    "имя приходит без префикса, аргументы — JSON-строкой",
  );
  assert.deepEqual(finishOf(parts).finishReason, {
    unified: "tool-calls",
    raw: "tool_use",
  });
  assert.equal(textOf(parts), "Сейчас ");
});

test("инструмент вне списка — отказ, а не вызов чего попало", async (t) => {
  fakeCli(t, "foreign-tool");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt(), tools: [WEATHER] })),
  );
  assert.equal(error.name, "ClaudeCliError");
  assert.match(error.message, /outside the current inventory: Bash/u);
});

test("ошибка API в assistant доезжает текстом и остаётся поправимой", async (t) => {
  fakeCli(t, "api-error");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /API Error: 500 internal server error/u);
  assert.equal(
    classifyModelCallError(error),
    "recoverable",
    "ход чинится повтором, а не отравлением сессии",
  );
});

test("обрыв потока без result — незавершённый ответ, а не половина хода", async (t) => {
  fakeCli(t, "truncated");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /incomplete response/u);
  assert.equal(classifyModelCallError(error), "recoverable");
});

test("нулевой код выхода с непустым result не выдаётся за успех", async (t) => {
  fakeCli(t, "exit-noise");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /exit 7/u);
});

// ─── Тишина, отмена, отсутствие бинаря ──────────────────────────────────────────────────

test("тишина дольше порога валит ход, а событие порог сбрасывает", async (t) => {
  const silent = fakeCli(t, "silent");
  void silent;
  const model = makeClaudeCliModel(MODEL, { silenceTimeoutMs: 300 });
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /produced nothing for 0\.3s/u);
  assert.equal(classifyModelCallError(error), "recoverable");

  // Порог 2500 мс, событие каждые 400 мс: без сброса таймера ход умер бы на 2500 мс, а с ним
  // живёт до конца (событий всего на 3200 мс). Запас в шесть раз больше промежутка: тесты идут
  // параллельно, и под нагрузкой подделка может опоздать — но не на секунды.
  fakeCli(t, "slow", {
    FAKE_CLAUDE_INTERVAL_MS: "400",
    FAKE_CLAUDE_EVENTS: "8",
  });
  const slow = await drain(
    await makeClaudeCliModel(MODEL, {
      silenceTimeoutMs: 2_500,
    }).doStream({ prompt: userPrompt() }),
  );
  assert.equal(textOf(slow), "x".repeat(8));
  assert.equal(finishOf(slow).finishReason.unified, "stop");
});

test("порог тишины в бою — три минуты", () => {
  assert.equal(CLAUDE_SILENCE_TIMEOUT_MS, 180_000);
});

test("AbortSignal убивает claude и всех его детей", async (t) => {
  const fake = fakeCli(t, "silent");
  const model = makeClaudeCliModel(MODEL, { silenceTimeoutMs: 30_000 });
  const controller = new AbortController();
  const parts = drain(
    await model.doStream({
      prompt: userPrompt(),
      abortSignal: controller.signal,
    }),
  );
  // Даём подделке завестись и записать свой pid, затем отменяем ход.
  const pid = await waitForPid(fake);
  controller.abort(cancellation());
  const error = await failureOf(() => parts);
  // Наружу едет причина отмены, а не своя ошибка на её месте: по ней eve и узнаёт, что ход
  // сняли, — иначе снятый ход поехал бы у неё как поправимый отказ модели, то есть повтором.
  assert.equal(error.name, "TurnCancelledError");
  assert.equal(classifyModelCallError(error), "terminal");
  await waitForExit(pid);
  assert.throws(() => process.kill(pid, 0), /ESRCH|EPERM/u);
});

test("отменённый до старта ход не поднимает ни CLI, ни реле, ни временной папки", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL, { silenceTimeoutMs: 8_000 });
  const controller = new AbortController();
  controller.abort();
  const before = tempDirs();
  const started = Date.now();
  const error = await failureOf(async () =>
    drain(
      await model.doStream({
        prompt: userPrompt(),
        abortSignal: controller.signal,
      }),
    ),
  );
  assert.equal(error.name, "AbortError");
  assert.ok(
    Date.now() - started < 1_000,
    "отказ мгновенный, а не по таймауту тишины",
  );
  assert.equal(existsSync(fake.dump), false, "процесс CLI не поднимался");
  assert.deepEqual(tempDirs(), before, "временной папки не появилось");
});

test("временная папка уходит раньше, чем ход отдаёт ответ", async (t) => {
  fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  const before = tempDirs();
  const reader = (
    await model.doStream({ prompt: userPrompt() })
  ).stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done === true) break;
    if (next.value.type === "finish")
      assert.deepEqual(
        tempDirs(),
        before,
        "системный промпт хода уже убран с диска",
      );
  }
  assert.deepEqual(tempDirs(), before);
});

// CLI закрыл вывод и вышел чуть позже: шаг дождался выхода, и ожидание выхода больше ничего
// не держит — иначе процесс Iva, поднятый ради одного запуска расписания, жил бы лишние секунды.
// Шаг идёт в отдельном процессе: таймеры этого файла от прошлых тестов его не касаются.
test("после выхода CLI ожидание выхода не держит процесс Iva", async (t) => {
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Готово" }),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([{ type: "text", text: "Готово" }], "end_turn"),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        usage: STEP_USAGE,
      },
    ],
    { FAKE_CLAUDE_LINGER_MS: "300" },
  );
  const step = `
    import { makeClaudeCliModel } from ${JSON.stringify(new URL("./claude-cli.ts", import.meta.url).href)};
    const { stream } = await makeClaudeCliModel(${JSON.stringify(MODEL)}).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "привет" }] }],
    });
    const reader = stream.getReader();
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === "text-delta") text += next.value.delta;
    }
    process.stdout.write(text + "\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", step], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let printed = "";
  let drainedAt = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    printed += chunk;
    drainedAt = performance.now();
  });
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0);
  assert.equal(printed, "Готово\n");
  assert.ok(
    performance.now() - drainedAt < 2_000,
    "процесс вышел сразу после шага, а не по таймеру ожидания выхода",
  );
});

test("шаг с отменённым сигналом доезжает до отмены и на doGenerate", async () => {
  const controller = new AbortController();
  controller.abort(cancellation());
  const error = await failureOf(async () =>
    makeClaudeCliModel(MODEL).doGenerate({
      prompt: userPrompt(),
      abortSignal: controller.signal,
    }),
  );
  assert.equal(classifyModelCallError(error), "terminal");
});

// Сигнал, отменённый без причины (`abort()` без аргумента), тоже обязан назваться отменой:
// свою ошибку на это место ставить нечего, у отмены уже есть имя.
test("отмена без причины остаётся отменой, а не отказом CLI", async (t) => {
  const fake = fakeCli(t, "text");
  const controller = new AbortController();
  controller.abort();
  const error = await failureOf(async () =>
    drain(
      await makeClaudeCliModel(MODEL).doStream({
        prompt: userPrompt(),
        abortSignal: controller.signal,
      }),
    ),
  );
  assert.equal(error.name, "AbortError");
  assert.equal(existsSync(fake.dump), false, "процесс CLI не поднимался");
});

test("реле отдаёт наружу пойманный ответ: и текст, и блоки, и расход — из него", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31"));
  const api = upstream;
  // Подделка CLI напечатала только голову ответа и выдумала свой расход: и то и другое
  // должно быть отброшено в пользу ответа, который поймало реле.
  const fake = fakeCli(t, "relay", {
    FAKE_CLAUDE_PRINT: "В Ташкенте ",
    FAKE_CLAUDE_TOKEN: "subscription-secret",
  });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: api.url,
  });
  const parts = await drain(
    await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );

  assert.equal(fake.read().answer, 200, "реле пропустило запрос к API");
  // Что именно доехало до API: адрес вместе со строкой запроса (её прибавляет CLI — по ней в
  // прошлом раунде и ломался ход), заголовок CLI как есть и расжатый ответ. Тело реле
  // пересобирает из прочитанного: длина посчитана заново и совпадает с телом.
  const [seen] = api.seen;
  assert.equal(seen?.url, "/v1/messages?beta=true");
  assert.equal(seen?.authorization, "Bearer subscription-secret");
  assert.equal(seen?.acceptEncoding, "identity");
  assert.equal(seen?.contentLength, String(seen?.body));
  assert.equal(
    textOf(parts),
    "В Ташкенте +31",
    "хвост, не доехавший от CLI, дописан из пойманного ответа",
  );
  // Вызов инструмента подделка не печатала вовсе: он приехал из блока ответа API.
  const calls = partsOfType(parts, "tool-call");
  assert.deepEqual(
    calls.map((call) => [call.toolName, call.input]),
    [["weather", '{"city":"Ташкент"}']],
  );
  const finish = finishOf(parts);
  assert.deepEqual(finish.finishReason, {
    unified: "tool-calls",
    raw: "tool_use",
  });
  // Расход — из ответа API (11 + 800 кэша, 12 выходных и 5 думающих), а не из рассказа CLI
  // о себе: подделка называла 999/999 в своём `assistant` и своём `result`.
  assert.deepEqual(finish.usage.inputTokens, {
    total: 811,
    noCache: 11,
    cacheRead: 0,
    cacheWrite: 800,
  });
  assert.equal(finish.usage.outputTokens.total, 12);
  assert.equal(finish.usage.outputTokens.reasoning, 5);
  const relay = finish.providerMetadata?.["iva-claude"] as {
    upstreamRequests?: number;
    deniedRequests?: number;
    cacheWriteTokens?: number;
  };
  assert.equal(relay.upstreamRequests, 1, "ход — это ровно один запрос к API");
  assert.equal(relay.deniedRequests, 0);
  assert.equal(relay.cacheWriteTokens, 800);
});

// Боевая ветка Fable: CLI, получив ответ, идёт за продолжением сам. Реле его отбивает, CLI
// объявляет ошибку API и выходит единицей — и всё это НЕ провал шага, а его работа по плану.
test("отбитый второй запрос CLI — не провал хода, а работа реле", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31"));
  const fake = fakeCli(t, "relay", {
    FAKE_CLAUDE_SECOND: "1",
    FAKE_CLAUDE_PRINT: "В Ташкенте +31",
  });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const parts = await drain(
    await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );

  const second = fake.read().second as { status: number; body: string };
  assert.equal(second.status, 400, "второй запрос CLI не ушёл наружу");
  assert.match(second.body, /IVA_MODEL_ADMISSION_CONSUMED/u);
  assert.equal(upstream.seen.length, 1, "к API ушёл ровно один запрос");
  assert.equal(textOf(parts), "В Ташкенте +31");
  const finish = finishOf(parts);
  assert.equal(finish.finishReason.unified, "tool-calls");
  assert.equal(finish.usage.inputTokens.total, 811);
  const relay = finish.providerMetadata?.["iva-claude"] as {
    upstreamRequests?: number;
    deniedRequests?: number;
  };
  assert.equal(relay.upstreamRequests, 1);
  assert.equal(relay.deniedRequests, 1);
});

// Обратная сторона той же ветки: реле запрос пропустило, а целого ответа не собралось.
// Верить пересказу CLI тут нельзя — ход оборвался на настоящем запросе, и так и надо сказать.
test("оборванный ответ API не подменяется рассказом CLI о нём", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31").slice(0, 5));
  fakeCli(t, "relay", { FAKE_CLAUDE_PRINT: "В Ташкенте" });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt(), tools: [WEATHER] })),
  );
  assert.equal(error.name, "ClaudeCliError");
  assert.match(error.message, /did not finish the response/u);
  assert.equal(classifyModelCallError(error), "recoverable");
});

// Ночь 22.09 на c1: апстрим оборвал поток, CLI пошёл за ответом вторым, нестриминговым
// запросом, реле его отбило — и в журнал уехал отказ реле вместо причины обрыва.
test("обрыв ответа API назван обрывом, а не отказом реле на второй запрос CLI", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31").slice(0, 5));
  const fake = fakeCli(t, "relay", {
    FAKE_CLAUDE_SECOND: "1",
    FAKE_CLAUDE_PRINT: "В Ташкенте",
  });
  const error = await failureOf(async () =>
    drain(
      await makeClaudeCliModel(MODEL, {
        silenceTimeoutMs: 10_000,
        upstream: upstream.url,
      }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
    ),
  );
  assert.equal(
    fake.read().fallback,
    "1",
    "CLI не идёт за ответом вторым, нестриминговым запросом",
  );
  assert.doesNotMatch(error.message, /IVA_MODEL_ADMISSION_CONSUMED/u);
  assert.match(error.message, /broke off before message_stop/u);
});

test("целый ответ API, начатый словами «API Error», — ответ модели, а не отказ", async (t) => {
  const upstream = await stubApi(
    t,
    relayAnswer("API Error: так называется глава"),
  );
  fakeCli(t, "relay");
  const parts = await drain(
    await makeClaudeCliModel(MODEL, {
      silenceTimeoutMs: 10_000,
      upstream: upstream.url,
    }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );
  assert.equal(textOf(parts), "API Error: так называется глава");
  assert.equal(finishOf(parts).finishReason.unified, "tool-calls");
});

test("текст ошибки из result CLI доезжает в отказ шага", async (t) => {
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Ответ" }),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([{ type: "text", text: "Ответ" }], "end_turn"),
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        usage: STEP_USAGE,
        errors: ["Stream idle timeout - partial response received"],
      },
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const error = await failureOf(async () =>
    drain(await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() })),
  );
  assert.match(
    error.message,
    /error_during_execution \(exit 1\): Stream idle timeout - partial response received/u,
  );
});

test("текст CLI, не совпавший с пойманным ответом, валит ход с понятной причиной", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31"));
  fakeCli(t, "relay-mismatch", { FAKE_CLAUDE_PRINT: "" });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt(), tools: [WEATHER] })),
  );
  assert.equal(error.name, "ClaudeCliError");
  assert.match(
    error.message,
    /printed text that differs from the response it received/u,
  );
});

// Без пойманного ответа расход берётся из итога CLI, а не из его же сообщения ассистента:
// итог — это то, что CLI насчитал за весь запуск, и другого источника у шага нет.
test("расход без реле берётся из итога CLI", async (t) => {
  fakeCli(t, "text", {
    FAKE_CLAUDE_ASSISTANT_USAGE: JSON.stringify({
      input_tokens: 1,
      output_tokens: 1,
    }),
  });
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.equal(finishOf(parts).usage.inputTokens.total, 16);
  assert.equal(finishOf(parts).usage.outputTokens.total, 4);
});

// Переполненное окно модель называет своим словом, а eve обязана увидеть ту же стену, что и
// на потолке вывода: иначе обрезанный ответ уедет владельцу как законченный.
test("переполненное окно — это оборванный ответ, а не законченный", async (t) => {
  fakeCli(t, "text", { FAKE_CLAUDE_STOP: "model_context_window_exceeded" });
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.deepEqual(finishOf(parts).finishReason, {
    unified: "length",
    raw: "model_context_window_exceeded",
  });
});

test("нет бинаря — отказ с командой установки, а не молчание", async (t) => {
  fakeCli(t, "text");
  process.env.CLAUDE_COMMAND = join(tmpdir(), "iva-no-such-claude");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /did not start/u);
  assert.match(error.message, /npm install -g @anthropic-ai\/claude-code/u);
  assert.equal(classifyModelCallError(error), "recoverable");
});

test("doGenerate собирает тот же шаг в один результат", async (t) => {
  fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  const result = await model.doGenerate({ prompt: userPrompt() });
  assert.deepEqual(result.content, [{ type: "text", text: "Готово" }]);
  assert.deepEqual(result.finishReason, { unified: "stop", raw: "end_turn" });
  assert.equal(result.usage.inputTokens.total, 16);
});

test("длинный ответ доезжает целиком, без склейки текста", async (t) => {
  fakeCli(t, "long");
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.equal(textOf(parts), "a".repeat(4000));
});

async function waitForPid(fake: Fake): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Дампа ещё может не быть: подделка только заводится.
    if (existsSync(fake.dump)) {
      const pid = fake.read().pid;
      if (typeof pid === "number") return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("поддельный CLI не записал свой pid");
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ─── Чистые части: окружение, инструменты, усилие, расход ───────────────────────────────

test("имя модели для CLI и окно контекста берутся из одной таблицы", () => {
  // Рукопожатие отдаёт route-ид; CLI принимает своё имя — у миллионного окна с суффиксом [1m].
  assert.equal(claudeNativeModel("claude-fable-5-1"), "claude-fable-5-1[1m]");
  assert.equal(claudeNativeModel("fable"), "claude-fable-5-1[1m]");
  assert.equal(claudeNativeModel("opus"), "claude-opus-5-5[1m]");
  assert.equal(claudeNativeModel("claude-opus-5-5"), "claude-opus-5-5[1m]");
  assert.equal(claudeNativeModel("sonnet"), "claude-sonnet-5[1m]");
  assert.equal(
    claudeNativeModel(" claude-opus-5-5[1m] "),
    "claude-opus-5-5[1m]",
  );
  assert.equal(claudeNativeModel("haiku"), "claude-haiku-4-5-20251001");
  assert.equal(
    claudeNativeModel("claude-haiku-4-5"),
    "claude-haiku-4-5-20251001",
  );
  // Прошлые Opus подписки — тоже миллионное окно, то есть тоже с суффиксом: старый id в .env
  // не должен уехать к CLI голым именем.
  assert.equal(claudeNativeModel("claude-opus-5"), "claude-opus-5[1m]");
  assert.equal(claudeNativeModel("claude-opus-4-8"), "claude-opus-4-8[1m]");
  // Незнакомая модель уезжает как есть: чужой аккаунт не угадывают.
  assert.equal(claudeNativeModel("claude-mystery-9"), "claude-mystery-9");
  assert.deepEqual(claudeModel("claude-mystery-9"), {
    native: "claude-mystery-9",
    window: 200_000,
    adaptive: false,
  });
  assert.equal(claudeModel("haiku").window, 200_000);
  assert.equal(claudeModel("fable").window, 1_000_000);
  // adaptive thinking haiku не умеет — и он же не едет в тело запроса.
  assert.equal(claudeModel("haiku").adaptive, false);
  assert.equal(claudeModel("fable").adaptive, true);
  const haikuBody = claudeExtraBody({ prompt: userPrompt() }, [], "haiku");
  assert.equal(haikuBody.thinking, undefined);
  assert.equal(haikuBody.output_config, undefined);
  const fableBody = claudeExtraBody({ prompt: userPrompt() }, [], MODEL);
  assert.deepEqual(fableBody.thinking, { type: "adaptive" });
});

test("ключ API в окружении — отказ с именем переменной и без её значения", () => {
  const secret = "sk-ant-super-secret";
  const error = (() => {
    try {
      claudeEnv({ ANTHROPIC_API_KEY: secret }, "http://127.0.0.1:1/x");
      return undefined;
    } catch (caught) {
      return caught as Error;
    }
  })();
  assert.ok(error instanceof ClaudeCliError);
  assert.match(error.message, /ANTHROPIC_API_KEY/u);
  assert.ok(!error.message.includes(secret), "значение в журнал не попадает");
  assert.deepEqual(claudeConflicts({ ANTHROPIC_AUTH_TOKEN: "x" }), [
    "ANTHROPIC_AUTH_TOKEN",
  ]);
  // Чужой адрес API Iva не отменяет молча: ход всё равно ушёл бы через реле на
  // api.anthropic.com, и настройка владельца исчезла бы без единого слова.
  assert.deepEqual(
    claudeConflicts({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      ANTHROPIC_FOUNDRY_API_KEY: "k",
    }),
    ["ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_BASE_URL"],
  );
  // Выключенный бэкенд — не конфликт: `0`, `false` и пустое значение значат «нет».
  for (const value of ["", "0", "false", "no", "off", "OFF"])
    assert.deepEqual(claudeConflicts({ CLAUDE_CODE_USE_BEDROCK: value }), []);
  assert.deepEqual(claudeConflicts({ CLAUDE_CODE_USE_BEDROCK: "1" }), [
    "CLAUDE_CODE_USE_BEDROCK",
  ]);
  // Незнакомый бэкенд — тоже конфликт: имена вендор добавляет, а список имён стареет.
  assert.deepEqual(
    claudeConflicts({
      CLAUDE_CODE_USE_SOMETHING_NEW: "1",
      CLAUDE_CODE_USE_VERTEX: "",
    }),
    ["CLAUDE_CODE_USE_SOMETHING_NEW"],
  );
});

test("окружение CLI получает адрес реле и выключенный лишний трафик", () => {
  const env = claudeEnv(
    {
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/iva/.claude",
      EMPTY: undefined,
    },
    "http://127.0.0.1:9999/admit/x",
  );
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999/admit/x");
  assert.equal(env.ENABLE_TOOL_SEARCH, "false");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(env.DISABLE_AUTO_COMPACT, "1");
  // Чужой каталог настроек CLI не трогаем: там его логин.
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/iva/.claude");
  assert.equal("EMPTY" in env, false);
  // Унаследованное тело запроса — чужие инструменты поверх наших; своё едет в settings.json.
  assert.equal(
    "CLAUDE_CODE_EXTRA_BODY" in
      claudeEnv(
        { CLAUDE_CODE_EXTRA_BODY: '{"tools":[]}' },
        "http://127.0.0.1:1/x",
      ),
    false,
  );
  // Потолок вывода CLI обязан знать до запроса: иначе попросит у модели свой.
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(
    claudeEnv({}, "http://127.0.0.1:1/x", 2000).CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    "2000",
  );
});

test("команда CLI берётся из CLAUDE_COMMAND, иначе из PATH", () => {
  assert.equal(claudeCommand({}), "claude");
  assert.equal(claudeCommand({ CLAUDE_COMMAND: "  " }), "claude");
  assert.equal(claudeCommand({ CLAUDE_COMMAND: "/opt/claude" }), "/opt/claude");
});

test("имя инструмента — только ASCII до 50 символов", () => {
  const tool = (name: string): LanguageModelV4FunctionTool => ({
    ...WEATHER,
    name,
  });
  assert.equal(claudeTools([tool("a".repeat(50))]).names.length, 1);
  assert.throws(() => claudeTools([tool("a".repeat(51))]), /50/u);
  assert.throws(() => claudeTools([tool("погода")]), /A-Za-z0-9_-/u);
  assert.throws(() => claudeTools([tool("same"), tool("same")]), /unique/u);
  assert.throws(
    () =>
      claudeTools([
        {
          type: "provider",
          id: "openai.web_search",
          name: "x",
          args: {},
        } as never,
      ]),
    /function tools only/u,
  );
});

// Предупреждение — не украшение: вызывающий, попросивший строгий JSON или обязательный
// вызов инструмента, обязан узнать, что подписка этого не обещает.
test("непереданные гарантии названы предупреждением, а не потеряны", () => {
  const warnings = claudeWarnings({
    prompt: [],
    temperature: 0.7,
    toolChoice: { type: "required" },
    responseFormat: { type: "json" },
  });
  assert.deepEqual(
    warnings.map((warning) =>
      warning.type === "unsupported" ? warning.feature : warning.type,
    ),
    ["temperature", "toolChoice", "responseFormat"],
  );
  assert.deepEqual(
    claudeWarnings({
      prompt: [],
      toolChoice: { type: "auto" },
      responseFormat: { type: "text" },
    }),
    [],
  );
});

test("усилие уходит только из принятого списка", () => {
  assert.equal(claudeEffort("low"), "low");
  assert.equal(claudeEffort(" MAX "), "max");
  // minimal подписка отвергает, disabled Iva не знает вовсе.
  assert.equal(claudeEffort("minimal"), undefined);
  assert.equal(claudeEffort("disabled"), undefined);
  assert.equal(claudeEffort("turbo"), undefined);
  assert.equal(claudeEffort(undefined), undefined);

  const previous = process.env.THINKING_EFFORT;
  process.env.THINKING_EFFORT = "xhigh";
  const body = claudeExtraBody({ prompt: userPrompt() }, [], MODEL);
  assert.deepEqual(body.output_config, { effort: "xhigh" });
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
  if (previous === undefined) delete process.env.THINKING_EFFORT;
  else process.env.THINKING_EFFORT = previous;

  const limited = claudeExtraBody(
    { prompt: userPrompt(), maxOutputTokens: 700, stopSequences: ["STOP"] },
    [],
    MODEL,
  );
  assert.equal(limited.max_tokens, 700);
  assert.deepEqual(limited.stop_sequences, ["STOP"]);
  assert.deepEqual(
    claudeWarnings({
      prompt: userPrompt(),
      temperature: 0.5,
      topP: 0.9,
    }).map((warning) => (warning as { feature?: string }).feature),
    ["temperature", "topP"],
  );
});

test("расход складывает весь вход и отдельно называет кэш", () => {
  const usage = claudeUsage({
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
    output_tokens: 20,
    output_tokens_details: { thinking_tokens: 7 },
  });
  assert.deepEqual(usage.inputTokens, {
    total: 1050,
    noCache: 100,
    cacheRead: 900,
    cacheWrite: 50,
  });
  assert.deepEqual(usage.outputTokens, {
    total: 20,
    text: undefined,
    reasoning: 7,
  });
  // Мусор провайдера не превращается в расход: дробное и отрицательное — не токены.
  assert.deepEqual(
    claudeUsage({ input_tokens: 1.5, output_tokens: -3 }).inputTokens,
    {
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  );
  assert.equal(claudeUsage(undefined).outputTokens.total, 0);
});

test("readCompletion берёт текст, вызовы и причину из сообщений модели", () => {
  const completion = readCompletion(
    [
      {
        content: [
          { type: "thinking", thinking: "думаю" },
          { type: "text", text: "Иду " },
          {
            type: "tool_use",
            id: "toolu_1",
            name: `${CLAUDE_TOOL_PREFIX}weather`,
            input: { city: "Ташкент" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ],
    ["weather"],
  );
  assert.equal(completion.text, "Иду ");
  assert.deepEqual(completion.calls, [
    { id: "toolu_1", name: "weather", input: '{"city":"Ташкент"}' },
  ]);
  assert.equal(completion.stopReason, "tool_use");
  assert.equal(completion.usage.inputTokens.total, 5);
  assert.equal(completion.hasUsage, true);
  assert.equal(readCompletion([], []).hasUsage, false);
});
