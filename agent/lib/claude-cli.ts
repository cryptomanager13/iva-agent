// Модель вендора claude: Iva зовёт установленный и залогиненный Claude Code CLI на той же
// машине и говорит с ним на его языке — stream-json. Ключа нет: ни api.anthropic.com, ни
// подписочный токен не читаются отсюда, авторизацию держит CLI.
//
// Устройство одного шага:
//   1. История eve превращается в кадры stream-json: система уезжает отдельным файлом
//      (--system-prompt-file), пары «вызов инструмента/результат» — блоками tool_use и
//      tool_result в user-кадрах, картинки — только base64. Все кадры, кроме последнего
//      user-кадра, идут с shouldQuery:false и получают ответ `result num_turns:0`: это
//      переигрывание истории, а не ход модели (см. пробник probe.mjs).
//   2. Инструменты Iva уезжают ДВУМЯ путями сразу: манифест в муляж MCP, чтобы модель знала
//      их имена и схемы, и tools в CLAUDE_CODE_EXTRA_BODY. Муляж отвечает на tools/call
//      отказом: инструменты исполняет eve, не CLI.
//   3. Единственный настоящий запрос к api.anthropic.com идёт через локальное реле допуска
//      (claude-admission.ts). Оно пропускает первый POST /v1/messages и отбивает второй —
//      поэтому шагов eve ровно столько же, сколько запросов к api.anthropic.com, а
//      продолжение хода после tool_use делает eve, а не CLI.
//   4. Наружу (в eve) уезжает то, что вернул настоящий ответ: текст потоком по
//      stream_event text_delta, в конце — части tool-call, finish с расходом и причиной
//      остановки. Расход берётся из ПЕРВОГО ответа (реле запомнило его целиком), а не из
//      `result` CLI: у CLI свои представления о том, сколько он потратил.
//
// Процесс CLI — в своей группе (detached), поэтому отмена хода убивает и его, и детей
// (`process.kill(-pid)`), и не оставляет за собой висящих запросов. Тишина CLI дольше
// CLAUDE_SILENCE_TIMEOUT_MS считается смертью хода; таймер сбрасывается на КАЖДОМ событии,
// потому что думающая модель молчит между дельтами дольше, чем между кадрами.

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  JSONObject,
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4ToolResultPart,
  LanguageModelV4Usage,
  SharedV4FileData,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import {
  startAdmission,
  type Admission,
  type NativeBlock,
  type NativeMessage,
} from "./claude-admission.ts";
import { CANONICAL_REASONING_EFFORTS } from "./reasoning-levels.ts";

const CLAUDE_PROVIDER_ID = "iva-claude";
/** Префикс имён инструментов в муляже MCP: по нему видно, что вызов пришёл от Iva. */
export const CLAUDE_TOOL_PREFIX = "mcp__iva__";
/** Тишина CLI, после которой ход считается мёртвым. Отсчитывается заново на каждом событии. */
export const CLAUDE_SILENCE_TIMEOUT_MS = 180_000;
/** Сколько ждать выхода процесса после того, как он закрыл вывод. */
const CLAUDE_EXIT_GRACE_MS = 5_000;

const CLAUDE_UPSTREAM = "https://api.anthropic.com";
const INSTALL_HINT =
  "install it with `npm install -g @anthropic-ai/claude-code` or point CLAUDE_COMMAND at the binary";
/** Значения, при которых переменная означает «не включено». */
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);
const AUTH_CONFLICTS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const BACKEND_CONFLICTS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
/**
 * Что CLI обязан видеть с этими значениями. Телеметрия и необязательный трафик выключены:
 * они уходят на чужие адреса, а ход — это запрос к api.anthropic.com и ничего больше.
 * Повторы выключены: реле допуска пропускает ОДИН запрос, и повтор CLI — это второй.
 * Автосжатие выключено: историю держит eve, а сжатая CLI история ломает кэш подписки.
 */
const CLAUDE_ENV: Record<string, string> = {
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_MAX_RETRIES: "0",
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_COMPACT: "1",
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
};
/**
 * Пул моделей аккаунта. Рукопожатие CLI отдаёт route-ид (`resolvedModel`): `claude-fable-5-1`,
 * `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` — и он же ложится в
 * CLAUDE_MODEL. CLI же выбирает модель по СВОЕМУ имени, и у миллионного окна оно с суффиксом
 * `[1m]`: `claude -p --model claude-fable-5-1` отвечает «It may not exist or you may not have
 * access to it» (проверено живьём 22.09.2026, CLI 2.1.278, план Max), а
 * `claude-fable-5-1[1m]` — работает. Haiku 4.5 миллионного окна не умеет вовсе, поэтому едет
 * без суффикса. Окно контекста считается здесь же: одно число на весь вендор было бы враньём
 * в одну из сторон, а меньшее окно безопаснее большего — оно лишь раньше сжимает историю,
 * тогда как завышенное валит ход на первом же переполнении.
 */
const CLAUDE_MODELS: Record<
  string,
  {
    readonly native: string;
    readonly window: number;
    readonly adaptive: boolean;
  }
> = {
  "claude-fable-5-1": {
    native: "claude-fable-5-1",
    window: 1_000_000,
    adaptive: true,
  },
  "claude-opus-5": {
    native: "claude-opus-5",
    window: 1_000_000,
    adaptive: true,
  },
  "claude-sonnet-5": {
    native: "claude-sonnet-5",
    window: 1_000_000,
    adaptive: true,
  },
  // Haiku 4.5 adaptive thinking не умеет: с ним подписка отвечает
  // 400 «adaptive thinking is not supported on this model» (живьём 22.09.2026).
  "claude-haiku-4-5-20251001": {
    native: "claude-haiku-4-5-20251001",
    window: 200_000,
    adaptive: false,
  },
};
/** Короткие имена из списка аккаунта и старых .env — те же модели. */
const CLAUDE_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};
/** Незнакомая модель: окно берём меньшее из известных — см. рассуждение выше. */
const CLAUDE_UNKNOWN_WINDOW = 200_000;

/**
 * Имя для `--model` и окно контекста одной моделью: `[1m]` снимается с route-ида (его может
 * дописать владелец руками), короткое имя разворачивается в полное, миллионному окну суффикс
 * возвращается. Незнакомый ид уезжает как есть: чужой аккаунт не угадывают, а отказ CLI
 * назовёт модель по имени.
 */
export function claudeModel(route: string): {
  readonly native: string;
  readonly window: number;
  readonly adaptive: boolean;
} {
  const asked = route.trim();
  const bare = asked.replace(/\[1m\]$/u, "");
  const entry = CLAUDE_MODELS[CLAUDE_ALIASES[bare] ?? bare];
  if (entry === undefined)
    return { native: asked, window: CLAUDE_UNKNOWN_WINDOW, adaptive: false };
  return entry.window === 200_000
    ? entry
    : { ...entry, native: `${entry.native}[1m]` };
}

/** Имя модели в том виде, в каком его понимает `claude -p --model`. */
export function claudeNativeModel(route: string): string {
  return claudeModel(route).native;
}

/** Окно контекста выбранной модели: та же таблица, что и у имени для CLI. */
export function claudeContextWindow(route: string): number {
  return claudeModel(route).window;
}

/** Имя инструмента: то же правило, что у Anthropic — до 50 символов ASCII. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,50}$/u;
/**
 * Усилия, которые принимает `output_config.effort`. `minimal` в их числе нет: подписка
 * отвечает на него 400, а `disabled` Iva и не знает — словарь лежит в reasoning-levels.ts
 * и общий с остальными вендорами.
 */
const CLAUDE_EFFORTS: readonly string[] = CANONICAL_REASONING_EFFORTS.filter(
  (effort) => effort !== "minimal",
);
const SAMPLING_DETAILS = "Claude by subscription rejects sampling controls";
const SAMPLING_FIELDS = [
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
] as const;

/**
 * Муляж MCP: список инструментов и отказ на любой вызов. Живёт inline-скриптом в `node -e`,
 * а не файлом рядом: собранный eve бандл не обещает, что соседний файл доедет до установки.
 * Последний аргумент — файл манифеста (`node -e <код> <манифест>` даёт его в argv[1]).
 */
const INERT_MCP = `const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\\n");
    if (end < 0) return;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.trim() === "") continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!("id" in row)) continue;
    const result = row.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "iva-inert-inventory", version: "1" } }
      : row.method === "tools/list"
        ? { tools: manifest }
        : { isError: true, content: [{ type: "text", text: "Denied: tools run in Iva, not here." }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\\n");
  }
});`;

/** Ошибка шага claude. Нарочно без statusCode: ход чинится повтором, а не отравлением сессии. */
export class ClaudeCliError extends Error {
  override readonly name = "ClaudeCliError";
}

/** Блок ответа модели: у Anthropic это text, thinking, tool_use, redacted_thinking и другие. */
type ClaudeBlock = NativeBlock;

/** Кадр stream-json: сообщение CLI в его собственном формате. */
export type ClaudeFrame = {
  readonly type: "user" | "assistant";
  message: { readonly role: "user" | "assistant"; content: ClaudeBlock[] };
  /** false — переигрывание истории: CLI отвечает `result num_turns:0` и не идёт к модели. */
  readonly shouldQuery?: boolean;
};

type ClaudeToolCall = {
  /** Идентификатор вызова: тот же, что придёт обратно в tool_result. */
  readonly id: string;
  /** Имя без префикса — то, что знает eve. */
  readonly name: string;
  /** Аргументы JSON-строкой, как их ждёт AI SDK. */
  readonly input: string;
};

/** Всё, что eve считает содержимым шага: текст, вызовы, причина остановки и расход. */
export type ClaudeCompletion = {
  readonly text: string;
  readonly calls: readonly ClaudeToolCall[];
  readonly stopReason: string | undefined;
  readonly usage: LanguageModelV4Usage;
  readonly hasUsage: boolean;
};

// ─── Инструменты ────────────────────────────────────────────────────────────────────────

type ClaudeToolManifest = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema7;
};

type ClaudeToolBody = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JSONSchema7;
};

/**
 * Раскладывает инструменты eve на две половины: манифест для муляжа MCP (имена и схемы,
 * которые видит модель) и тело запроса с префиксом. Схему не переписываем: у Anthropic она
 * та же JSON Schema, что у eve, а менять чужую схему на своей границе — терять поля.
 */
export function claudeTools(tools: LanguageModelV4CallOptions["tools"]): {
  manifest: ClaudeToolManifest[];
  body: ClaudeToolBody[];
  names: string[];
} {
  const manifest: ClaudeToolManifest[] = [];
  const body: ClaudeToolBody[] = [];
  const names: string[] = [];
  for (const tool of tools ?? []) {
    if (tool.type !== "function")
      throw new ClaudeCliError(
        `Claude CLI runs Iva function tools only, got a ${tool.type} tool`,
      );
    if (!TOOL_NAME.test(tool.name))
      throw new ClaudeCliError(
        `tool name ${JSON.stringify(tool.name)} does not match [A-Za-z0-9_-]{1,50}`,
      );
    if (names.includes(tool.name))
      throw new ClaudeCliError(
        `tool name ${JSON.stringify(tool.name)} is not unique in this request`,
      );
    const description = tool.description ?? "";
    names.push(tool.name);
    manifest.push({
      name: tool.name,
      description,
      inputSchema: tool.inputSchema,
    });
    body.push({
      name: CLAUDE_TOOL_PREFIX + tool.name,
      description,
      input_schema: tool.inputSchema,
    });
  }
  return { manifest, body, names };
}

/** Усилие рассуждения из THINKING_EFFORT; `minimal` и мусор не отправляются вовсе. */
export function claudeEffort(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  return CLAUDE_EFFORTS.includes(value) ? value : undefined;
}

/**
 * Тело, которое CLI подмешивает в запрос (CLAUDE_CODE_EXTRA_BODY): инструменты, adaptive
 * thinking, усилие, потолок вывода и стоп-последовательности. Температуры и top_p здесь нет
 * намеренно — подписка их отвергает, а не «принимает и игнорирует».
 */
export function claudeExtraBody(
  options: LanguageModelV4CallOptions,
  tools: readonly ClaudeToolBody[],
  route: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { tools };
  // adaptive thinking и усилие едут вместе: без первого второе не имеет смысла, а модель,
  // которая adaptive не умеет (haiku), отвергает и то и другое.
  if (claudeModel(route).adaptive) {
    body.thinking = { type: "adaptive" };
    const effort = claudeEffort(process.env.THINKING_EFFORT);
    if (effort !== undefined) body.output_config = { effort };
  }
  if (options.maxOutputTokens !== undefined)
    body.max_tokens = options.maxOutputTokens;
  if (options.stopSequences !== undefined && options.stopSequences.length > 0)
    body.stop_sequences = options.stopSequences;
  return body;
}

/** Что eve просил, а подписка не принимает: молчаливая потеря параметра выглядела бы поломкой хода. */
export function claudeWarnings(
  options: LanguageModelV4CallOptions,
): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  for (const field of SAMPLING_FIELDS)
    if (options[field] !== undefined)
      warnings.push({
        type: "unsupported",
        feature: field,
        details: SAMPLING_DETAILS,
      });
  return warnings;
}

// ─── История eve → кадры stream-json ────────────────────────────────────────────────────

/**
 * История eve в кадры CLI. Возвращает system отдельно: он уезжает файлом, а не кадром.
 * Последний кадр — всегда непустой user (иначе ход не начать: prefill ассистента CLI не
 * принимает), а все user-кадры до него помечены shouldQuery:false — это переигрывание.
 */
export function claudeHistory(prompt: LanguageModelV4Prompt): {
  system: string;
  frames: ClaudeFrame[];
} {
  const system: string[] = [];
  const frames: ClaudeFrame[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      if (frames.length > 0)
        throw new ClaudeCliError(
          "system messages must come before the history",
        );
      system.push(message.content);
      continue;
    }
    appendFrame(frames, ...messageBlocks(message));
  }
  return { system: system.join("\n\n"), frames: sealFrames(frames) };
}

type Role = "user" | "assistant";

function messageBlocks(
  message: Exclude<LanguageModelV4Message, { role: "system" }>,
): [Role, ClaudeBlock[]] {
  if (message.role === "user") return ["user", userBlocks(message.content)];
  if (message.role === "assistant")
    return ["assistant", assistantBlocks(message.content)];
  return ["user", toolResultBlocks(message.content)];
}

/** Подряд идущие user-блоки склеиваются в один кадр: у CLI один кадр — один ход истории. */
function appendFrame(
  frames: ClaudeFrame[],
  role: Role,
  blocks: ClaudeBlock[],
): void {
  if (blocks.length === 0) return;
  const last = frames.at(-1);
  if (role === "user" && last !== undefined && last.type === "user") {
    last.message.content.push(...blocks);
    return;
  }
  frames.push({ type: role, message: { role, content: blocks } });
}

function sealFrames(frames: ClaudeFrame[]): ClaudeFrame[] {
  const last = frames.at(-1);
  if (
    last === undefined ||
    last.type !== "user" ||
    last.message.content.length === 0
  )
    throw new ClaudeCliError(
      "Claude CLI needs the history to end with a non-empty user or tool-result message (assistant prefill is unsupported)",
    );
  return frames.map((frame, index) =>
    frame.type === "user" && index < frames.length - 1
      ? { ...frame, shouldQuery: false }
      : frame,
  );
}

function userBlocks(
  content: Extract<LanguageModelV4Message, { role: "user" }>["content"],
): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = [];
  for (const part of content) {
    if (part.type === "text") pushText(blocks, part.text);
    else if (part.type === "file") blocks.push(imageBlock(part));
    else
      throw new ClaudeCliError(
        `Claude prompt carries an unsupported ${partType(part)} part in a user message`,
      );
  }
  return blocks;
}

function assistantBlocks(
  content: Extract<LanguageModelV4Message, { role: "assistant" }>["content"],
): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = [];
  for (const part of content) {
    if (part.type === "text") pushText(blocks, part.text);
    else if (part.type === "tool-call")
      blocks.push({
        type: "tool_use",
        id: part.toolCallId,
        name: CLAUDE_TOOL_PREFIX + part.toolName,
        input: toolInput(part.input),
      });
    // Рассуждение в историю не возвращается: его режет withReasoningStripped, а подписка за
    // переигранное рассуждение без подписи отвечает отказом.
    else if (part.type !== "reasoning" && part.type !== "reasoning-file")
      throw new ClaudeCliError(
        `Claude prompt carries an unsupported ${partType(part)} part in an assistant message`,
      );
  }
  return blocks;
}

function toolResultBlocks(
  content: Extract<LanguageModelV4Message, { role: "tool" }>["content"],
): ClaudeBlock[] {
  return content.map((part) => {
    // Согласие на вызов инструмента Iva не спрашивает: инструменты eve исполняются сами.
    if (part.type !== "tool-result")
      throw new ClaudeCliError(
        `Claude CLI cannot be asked for a ${partType(part)} answer to a tool`,
      );
    return toolResultBlock(part);
  });
}

function toolResultBlock(part: LanguageModelV4ToolResultPart): ClaudeBlock {
  const output = part.output;
  const block: ClaudeBlock = {
    type: "tool_result",
    tool_use_id: part.toolCallId,
    content: toolResultContent(output),
  };
  if (isErrorOutput(output)) block.is_error = true;
  return block;
}

function toolResultContent(output: LanguageModelV4ToolResultOutput): unknown {
  if (output.type === "text" || output.type === "error-text")
    return output.value;
  if (output.type === "json" || output.type === "error-json")
    return JSON.stringify(output.value);
  if (output.type === "execution-denied") return output.reason ?? "Denied";
  return output.value.map((part) => resultContentBlock(part));
}

/** Часть внутри результата инструмента: текст или картинка, и ничего больше. */
function resultContentBlock(part: {
  readonly type: string;
  readonly text?: string;
  readonly mediaType?: string;
  readonly data?: SharedV4FileData;
}): ClaudeBlock {
  if (part.type === "text") return { type: "text", text: part.text ?? "" };
  if (part.type === "file") return imageBlock(part);
  throw new ClaudeCliError(
    `Claude CLI cannot take a ${part.type} part inside a tool result`,
  );
}

function isErrorOutput(output: { type: string }): boolean {
  return (
    output.type === "error-text" ||
    output.type === "error-json" ||
    output.type === "execution-denied"
  );
}

/** Имя части для сообщения об отказе: у закрытых союзов типов до ветки отказа не дойти. */
function partType(part: unknown): string {
  const type = (part as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" ? type : "unknown";
}

/** Текстовая часть: пустая не занимает места в кадре и не считается содержимым. */
function pushText(blocks: ClaudeBlock[], text: string): void {
  if (text.length > 0) blocks.push({ type: "text", text });
}

function imageBlock(part: {
  readonly mediaType?: string;
  readonly data?: SharedV4FileData;
}): ClaudeBlock {
  const mediaType = part.mediaType ?? "";
  if (!mediaType.startsWith("image/"))
    throw new ClaudeCliError(
      `Claude accepts images only, got ${mediaType || "an unknown media type"}`,
    );
  const data = part.data;
  if (data === undefined || data.type !== "data")
    throw new ClaudeCliError(
      `Claude accepts images only as inline base64 data, got a ${data?.type ?? "missing"} reference`,
    );
  const raw = data.data;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: base64Data(raw),
    },
  };
}

/** Байты кодируем сами, строку берём как base64 (срезав data-URL, если он пришёл целиком). */
function base64Data(raw: unknown): string {
  if (typeof raw === "string") return raw.replace(/^data:[^,]*;base64,/u, "");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("base64");
  throw new ClaudeCliError(
    "Claude accepts images only as bytes or base64 text",
  );
}

/** Аргументы вызова: AI SDK хранит их строкой, но история могла прийти и объектом. */
function toolInput(input: unknown): unknown {
  if (input === undefined || input === null) return {};
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new ClaudeCliError(
      "history carries a tool call whose input is not JSON",
    );
  }
}

// ─── Ответ модели → то, что видит eve ───────────────────────────────────────────────────

/** Собирает содержимое шага из сообщений модели: текст, вызовы инструментов и расход. */
export function readCompletion(
  messages: readonly NativeMessage[],
  names: readonly string[],
): ClaudeCompletion {
  const blocks = messages.flatMap((message) => message.content ?? []);
  const usage = messages.at(-1)?.usage;
  return {
    text: blocks
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => String(block.text))
      .join(""),
    calls: blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => toolCall(block, names)),
    stopReason: stopReasonOf(messages),
    usage: claudeUsage(usage),
    hasUsage:
      typeof usage?.input_tokens === "number" ||
      typeof usage?.output_tokens === "number",
  };
}

function toolCall(
  block: ClaudeBlock,
  names: readonly string[],
): ClaudeToolCall {
  const name = text(block.name);
  if (
    !name.startsWith(CLAUDE_TOOL_PREFIX) ||
    !names.includes(name.slice(CLAUDE_TOOL_PREFIX.length))
  )
    throw new ClaudeCliError(
      `Claude returned a tool outside the current inventory: ${name}`,
    );
  return {
    id: text(block.id),
    name: name.slice(CLAUDE_TOOL_PREFIX.length),
    // Отсутствующие аргументы — пустой объект (так их шлёт Anthropic для инструмента без
    // параметров), а всё остальное уезжает как есть, включая null: подменять значение модели
    // на своё — это выдумывать вызов, которого не было.
    input: JSON.stringify(block.input === undefined ? {} : block.input),
  };
}

function stopReasonOf(messages: readonly NativeMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reason = messages[index]?.stop_reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return undefined;
}

/**
 * Расход шага из usage настоящего ответа. `total` включает кэш: у Anthropic `input_tokens`
 * считает только некэшированный вход, а платит владелец за весь. cache-read и cache-write
 * едут отдельными полями — их ждёт agent/hooks/usage.ts.
 */
export function claudeUsage(
  usage: Record<string, unknown> | undefined,
): LanguageModelV4Usage {
  const input = tokenCount(usage?.input_tokens);
  const cacheRead = tokenCount(usage?.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage?.cache_creation_input_tokens);
  const details = usage?.output_tokens_details as
    Record<string, unknown> | undefined;
  return {
    inputTokens: {
      total: input + cacheRead + cacheWrite,
      noCache: input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: tokenCount(usage?.output_tokens),
      text: undefined,
      reasoning: tokenCount(details?.thinking_tokens),
    },
    raw: (usage ?? {}) as JSONObject,
  };
}

/** Строковое поле чужого JSON: не строка — пустая строка, а не «[object Object]». */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Токены — целое неотрицательное: дробное и отрицательное это мусор провайдера, не расход. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

// ─── Запуск CLI ─────────────────────────────────────────────────────────────────────────

/**
 * Окружение процесса CLI: своё плюс выключенный лишний трафик и адрес реле. Значения
 * посторонних ANTHROPIC_* или CLAUDE_CODE_USE_* не читаются и не печатаются: с ключом в
 * окружении CLI пошёл бы мимо подписки, а секрет в журнале — это секрет в журнале.
 */
export function claudeEnv(
  source: Readonly<Record<string, string | undefined>>,
  relayUrl: string,
): Record<string, string> {
  const conflicts = claudeConflicts(source);
  if (conflicts.length > 0)
    throw new ClaudeCliError(
      `Claude Code CLI refuses to run while ${conflicts.join(", ")} is set: unset ${conflicts.length > 1 ? "them" : "it"} and restart Iva (values are never printed)`,
    );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined) env[key] = value;
  return { ...env, ...CLAUDE_ENV, ANTHROPIC_BASE_URL: relayUrl };
}

/** Имена конфликтующих переменных — без значений: этого достаточно, чтобы починить .env. */
export function claudeConflicts(
  source: Readonly<Record<string, string | undefined>>,
): string[] {
  const names = AUTH_CONFLICTS.filter((key) => (source[key] ?? "").length > 0);
  return names.concat(
    BACKEND_CONFLICTS.filter(
      (key) => !OFF_VALUES.has((source[key] ?? "").toLowerCase()),
    ),
  );
}

/**
 * Бинарь CLI. `npm install -g` кладёт `claude` рядом с node, а PATH сервиса начинается с
 * каталога node (scripts/cli/systemd.ts), поэтому в обычной установке CLAUDE_COMMAND не нужен;
 * он тут для нестандартной. PATH не переписываем: подмена PATH — это чужие `claude` в ходу.
 */
export function claudeCommand(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = (env.CLAUDE_COMMAND ?? "").trim();
  return configured.length > 0 ? configured : "claude";
}

type PreparedCall = {
  readonly frames: ClaudeFrame[];
  readonly names: string[];
  readonly argv: string[];
};

/** Раскладывает один вызов по временной папке: system.md, tools.json, settings.json и argv. */
function prepareCall(
  model: string,
  options: LanguageModelV4CallOptions,
  session: ClaudeSession,
): PreparedCall {
  const dir = session.tempDir;
  const { system, frames } = claudeHistory(options.prompt);
  const tools = claudeTools(options.tools);
  writeFileSync(join(dir, "system.md"), system, "utf8");
  writeFileSync(
    join(dir, "tools.json"),
    JSON.stringify(tools.manifest),
    "utf8",
  );
  // Настройки приватные (в своей временной папке) и приходят через --settings: длинные схемы
  // инструментов не переживают execve-лимит на размер одного аргумента.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      env: {
        CLAUDE_CODE_EXTRA_BODY: JSON.stringify(
          claudeExtraBody(options, tools.body, model),
        ),
      },
    }),
    "utf8",
  );
  return { frames, names: tools.names, argv: claudeArgv(model, dir) };
}

function claudeArgv(model: string, dir: string): string[] {
  const manifestPath = join(dir, "tools.json");
  const mcp = JSON.stringify({
    mcpServers: {
      iva: { command: process.execPath, args: ["-e", INERT_MCP, manifestPath] },
    },
  });
  return [
    "-p",
    "--model",
    claudeNativeModel(model),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Свои инструменты CLI выключены: единственный источник имён — наш муляж MCP.
    "--tools",
    "",
    "--system-prompt-file",
    join(dir, "system.md"),
    "--settings",
    join(dir, "settings.json"),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--max-turns",
    "1",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--mcp-config",
    mcp,
  ];
}

/** Временная папка, реле и процесс в одном месте: отмена и уборка — это один вызов. */
class ClaudeSession {
  tempDir: string;
  private child: ChildProcess | undefined;
  private admission: Admission | undefined;

  constructor() {
    this.tempDir = mkdtempSync(join(tmpdir(), "iva-claude-"));
  }

  adopt(admission: Admission): void {
    this.admission = admission;
  }

  attach(child: ChildProcess): void {
    this.child = child;
    // После `spawn` ошибка процесса приходит сюда: без слушателя она стала бы исключением
    // в чужом стеке, а ход и так узнает о беде по закрытому выводу.
    child.on("error", () => undefined);
  }

  abort(): void {
    this.admission?.abort();
    killTree(this.child);
  }

  async close(): Promise<void> {
    this.abort();
    await this.admission?.close();
    rmSync(this.tempDir, { recursive: true, force: true });
  }
}

/**
 * Убивает процесс и всех его детей. CLI — это node, который сам поднимает детей (муляж MCP),
 * поэтому `kill` по одному pid оставил бы их висеть; группа процессов заводится при запуске
 * (detached), и минус-pid бьёт по всей группе.
 */
function killTree(child: ChildProcess | undefined): void {
  if (child === undefined || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function spawnClaude(
  command: string,
  argv: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  const child = spawn(command, argv, options);
  return await new Promise<ChildProcess>((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", (error: Error) =>
      reject(
        new ClaudeCliError(
          `claude CLI (${command}) did not start: ${error.message}; ${INSTALL_HINT}`,
        ),
      ),
    );
  });
}

// ─── Чтение вывода CLI ──────────────────────────────────────────────────────────────────

/** Строки stdout как JSON-события CLI: одна строка — одно событие. */
async function* jsonLines(
  stream: Readable,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.write(chunk as Buffer);
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim().length > 0) yield parseEvent(line);
      end = buffer.indexOf("\n");
    }
  }
  buffer += decoder.end();
  if (buffer.trim().length > 0) yield parseEvent(buffer);
}

function parseEvent(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null)
    throw new ClaudeCliError(
      "Claude CLI printed a stream-json line that is not an object",
    );
  return parsed as Record<string, unknown>;
}

/**
 * Тишина дольше timeoutMs — смерть хода, но таймер взводится заново на каждом событии:
 * думающая модель молчит между дельтами дольше, чем CLI между кадрами.
 */
async function* silentFor(
  source: AsyncGenerator<Record<string, unknown>>,
  timeoutMs: number,
): AsyncGenerator<Record<string, unknown>> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ClaudeCliError(
              `Claude CLI produced nothing for ${timeoutMs / 1000}s`,
            ),
          ),
        timeoutMs,
      );
    });
    let next: IteratorResult<Record<string, unknown>>;
    try {
      next = await Promise.race([iterator.next(), expired]);
    } finally {
      clearTimeout(timer);
    }
    if (next.done === true) return;
    yield next.value;
  }
}

// ─── Шаг модели ─────────────────────────────────────────────────────────────────────────

type ClaudeSettings = {
  /** Тишина CLI до отказа; в тестах — доли секунды, в бою CLAUDE_SILENCE_TIMEOUT_MS. */
  readonly silenceTimeoutMs?: number;
  /**
   * Адрес API, на который реле пересылает шаг. В бою — api.anthropic.com; в тестах — заглушка:
   * без подмены боевая ветка «ответ поймало реле» не наблюдаема вовсе, а в ней живут и расход,
   * и блоки ответа, и сверка напечатанного CLI с полученным.
   */
  readonly upstream?: string;
};

/** Что шаг берёт из настроек модели: тишина CLI и адрес, куда реле пересылает запрос. */
type ClaudeRun = {
  readonly silenceMs: number;
  readonly upstream: string;
};

/** Рукописная LanguageModelV4: шаг модели — это один запуск Claude Code CLI. */
export function makeClaudeCliModel(
  model: string,
  settings: ClaudeSettings = {},
): LanguageModelV4 {
  const run: ClaudeRun = {
    silenceMs: settings.silenceTimeoutMs ?? CLAUDE_SILENCE_TIMEOUT_MS,
    upstream: settings.upstream ?? CLAUDE_UPSTREAM,
  };
  return {
    specificationVersion: "v4",
    provider: CLAUDE_PROVIDER_ID,
    modelId: model,
    // Картинки едут только base64: URL пришлось бы скачивать, а у CLI нет для этого канала.
    supportedUrls: {},
    doStream: (options: LanguageModelV4CallOptions) =>
      Promise.resolve(streamCall(model, options, run)),
    doGenerate: (options: LanguageModelV4CallOptions) =>
      generateCall(model, options, run),
  };
}

/**
 * Шаг модели. Ход, отменённый ДО старта, не поднимает ничего: ни процесса CLI, ни реле, ни
 * временной папки. Одного слушателя `abort` тут мало — на уже отменённом сигнале он не
 * срабатывает никогда, и ход оплачивал бы запрос к API, а `claude -p` висел бы до таймаута
 * тишины (QA: 8116 мс при пороге 8 с, в бою было бы 180 с).
 */
function streamCall(
  model: string,
  options: LanguageModelV4CallOptions,
  run: ClaudeRun,
): LanguageModelV4StreamResult {
  if (options.abortSignal?.aborted === true) return abortedStream();
  const session = new ClaudeSession();
  const onAbort = () => {
    session.abort();
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "stream-start",
        warnings: claudeWarnings(options),
      });
      void runCall({ model, options, session, controller, run })
        .catch((error: unknown) => {
          try {
            controller.error(asClaudeError(error));
          } catch {
            // Поток уже закрыт отменой хода: сообщать ошибку некому.
            return;
          }
        })
        .finally(() =>
          options.abortSignal?.removeEventListener("abort", onAbort),
        );
    },
    cancel() {
      session.abort();
    },
  });
  return { stream };
}

/** Отменённый до старта ход: поток кончается отказом, и ни один процесс не запускается. */
function abortedStream(): LanguageModelV4StreamResult {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.error(
          new ClaudeCliError("Claude CLI step was aborted before it started"),
        );
      },
    }),
  };
}

type RunContext = {
  readonly model: string;
  readonly options: LanguageModelV4CallOptions;
  readonly session: ClaudeSession;
  readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  readonly run: ClaudeRun;
};

async function runCall(context: RunContext): Promise<void> {
  const { model, options, session, controller, run } = context;
  const text = new TextStream();
  try {
    const prepared = prepareCall(model, options, session);
    const admission = await startAdmission(run.upstream, run.silenceMs);
    session.adopt(admission);
    const env = claudeEnv(process.env, admission.url);
    const child = await spawnClaude(claudeCommand(env), prepared.argv, {
      cwd: session.tempDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Своя группа процессов: отмена бьёт по ней целиком (см. killTree).
      detached: true,
    });
    session.attach(child);
    if (child.stdout === null)
      throw new ClaudeCliError("Claude CLI started without a stdout pipe");
    const events = silentFor(jsonLines(child.stdout), run.silenceMs);
    await writeFrames(child, prepared.frames, events);
    const seen = await collect(events, text, controller);
    const exit = await waitForExit(child);
    const completion = complete(admission, seen, exit, prepared.names);
    emit(completion, text, admission, controller);
    report(model, completion, admission);
  } finally {
    await session.close();
  }
}

/** Кадр за кадром; на переигрывании ждём `result num_turns:0` — иначе история не принята. */
async function writeFrames(
  child: ChildProcess,
  frames: readonly ClaudeFrame[],
  events: AsyncGenerator<Record<string, unknown>>,
): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null)
    throw new ClaudeCliError("Claude CLI started without a stdin pipe");
  for (const frame of frames) {
    stdin.write(`${JSON.stringify(frame)}\n`);
    if (frame.shouldQuery === false) await awaitReplay(events);
  }
  stdin.end();
}

async function awaitReplay(
  events: AsyncGenerator<Record<string, unknown>>,
): Promise<void> {
  for (;;) {
    const next = await events.next();
    if (next.done === true)
      throw new ClaudeCliError(
        "Claude CLI exited before acknowledging the replayed history",
      );
    const event = next.value;
    if (event.type !== "result") continue;
    if (event.num_turns !== 0 || event.is_error === true)
      throw new ClaudeCliError(
        `Claude CLI did not replay the history (${String(event.subtype)} at ${String(event.num_turns)} turns)`,
      );
    return;
  }
}

type Collected = {
  readonly assistants: NativeMessage[];
  readonly results: Record<string, unknown>[];
  readonly stopped: boolean;
  readonly nativeError: string | undefined;
};

/** Читает ответ CLI до конца вывода: текст уезжает в поток сразу, остальное собирается. */
async function collect(
  events: AsyncGenerator<Record<string, unknown>>,
  text: TextStream,
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
): Promise<Collected> {
  const assistants: NativeMessage[] = [];
  const results: Record<string, unknown>[] = [];
  let stopped = false;
  let nativeError: string | undefined;
  for await (const event of events) {
    if (event.type === "assistant") {
      const assistant = readAssistant(event);
      if (assistant.error !== undefined) nativeError = assistant.error;
      else if (assistant.message !== undefined)
        assistants.push(assistant.message);
    } else if (event.type === "result") results.push(event);
    else if (event.type === "stream_event") {
      stopped = applyStreamEvent(event, text, controller) || stopped;
    }
  }
  return { assistants, results, stopped, nativeError };
}

/** Полное сообщение ассистента или ошибка провайдера, которую CLI назвал сам. */
function readAssistant(event: Record<string, unknown>): {
  message?: NativeMessage;
  error?: string;
} {
  const message = event.message as NativeMessage | undefined;
  const text = message === undefined ? "" : textOf(message);
  const named =
    event.error !== undefined ||
    message?.error !== undefined ||
    /^API Error/u.test(text);
  if (named)
    return { error: text.trim().length > 0 ? text : "Claude API error" };
  return message === undefined ? {} : { message };
}

function textOf(message: NativeMessage): string {
  return (message.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

/** Дельта частичного сообщения: текст едет наружу, `message_stop` отмечает конец ответа. */
function applyStreamEvent(
  event: Record<string, unknown>,
  text: TextStream,
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
): boolean {
  const native = event.event as Record<string, unknown> | undefined;
  if (native?.type === "message_stop") return true;
  const delta = native?.delta as Record<string, unknown> | undefined;
  if (delta?.type === "text_delta" && typeof delta.text === "string")
    text.push(delta.text, controller);
  return false;
}

/** Копит текст ответа и держит один текстовый блок открытым, пока в него что-то едет. */
class TextStream {
  private id: string | undefined;
  private written = "";

  get emitted(): string {
    return this.written;
  }

  push(
    delta: string,
    controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
  ): void {
    if (delta.length === 0) return;
    this.id ??= `txt-${randomUUID()}`;
    if (this.written.length === 0)
      controller.enqueue({ type: "text-start", id: this.id });
    this.written += delta;
    controller.enqueue({ type: "text-delta", id: this.id, delta });
  }

  close(
    controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
  ): void {
    if (this.id !== undefined)
      controller.enqueue({ type: "text-end", id: this.id });
  }
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const expired = new Promise<never>((_resolve, reject) =>
    setTimeout(
      () =>
        reject(
          new ClaudeCliError(
            "Claude CLI did not exit after closing its output",
          ),
        ),
      CLAUDE_EXIT_GRACE_MS,
    ),
  );
  await Promise.race([closed, expired]);
  return child.exitCode;
}

/**
 * Что считать ответом модели. Реле запомнило настоящий ответ целиком — он и есть правда:
 * CLI мог его обрезать, а его собственный второй поход в API отбит реле. Без запомненного
 * ответа верим CLI, но требуем целостности: один `result`, хоть одно сообщение ассистента
 * и увиденный `message_stop`. Отдельная граница — `error_max_turns` с вызовами инструментов
 * и кодом выхода 1: это штатный конец хода после tool_use, а не отказ.
 */
function complete(
  admission: Admission,
  seen: Collected,
  exit: number | null,
  names: readonly string[],
): ClaudeCompletion {
  const captured = admission.capture.complete
    ? admission.capture.message
    : null;
  if (captured !== null) return readCompletion([captured], names);
  throwIfNativeError(seen, admission);
  const result = lastResult(seen, admission);
  const completion = readCompletion(seen.assistants, names);
  if (!isToolBoundary(completion, result, exit)) assertSuite(result, exit);
  return completion;
}

/** Ошибку, которую CLI назвал сам (assistant с `error` или текстом `API Error`), не глотаем. */
function throwIfNativeError(seen: Collected, admission: Admission): void {
  if (seen.nativeError !== undefined)
    throw new ClaudeCliError(`${seen.nativeError}${upstreamNote(admission)}`);
}

/** Последний `result` CLI; без него или без сообщений ассистента ответ неполный. */
function lastResult(
  seen: Collected,
  admission: Admission,
): Record<string, unknown> | undefined {
  const result = seen.results.at(-1);
  const subtype = text(result?.subtype);
  if (
    seen.results.length !== 1 ||
    seen.assistants.length === 0 ||
    !seen.stopped
  )
    throw new ClaudeCliError(
      `Claude CLI returned an incomplete response (${subtype || "no result"}${upstreamNote(admission)})`,
    );
  return result;
}

/**
 * Штатная граница хода: модель позвала инструменты, CLI упёрся в `--max-turns 1` и вышел
 * единицей. Это не отказ, а конец шага: вызовы уезжают в eve, и ход продолжает она.
 */
function isToolBoundary(
  completion: ClaudeCompletion,
  result: Record<string, unknown> | undefined,
  exit: number | null,
): boolean {
  return (
    completion.calls.length > 0 &&
    text(result?.subtype) === "error_max_turns" &&
    exit === 1
  );
}

function assertSuite(
  result: Record<string, unknown> | undefined,
  exit: number | null,
): void {
  const subtype = text(result?.subtype);
  if (exit === 0 && result?.is_error !== true && subtype === "success") return;
  throw new ClaudeCliError(
    `Claude CLI failed: ${subtype || "no subtype"}${exit === 0 ? "" : ` (exit ${String(exit)})`}`,
  );
}

function upstreamNote(admission: Admission): string {
  return admission.status !== undefined && admission.status !== 200
    ? `, api.anthropic.com answered HTTP ${admission.status}`
    : "";
}

/** Отдаёт шаг наружу: текст, вызовы инструментов, расход и причина остановки. */
function emit(
  completion: ClaudeCompletion,
  text: TextStream,
  admission: Admission,
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
): void {
  reconcile(text, completion.text, controller);
  text.close(controller);
  for (const call of completion.calls)
    controller.enqueue({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
    });
  controller.enqueue({
    type: "finish",
    finishReason: finishOf(completion),
    usage: completion.usage,
    providerMetadata: {
      [CLAUDE_PROVIDER_ID]: {
        stopReason: completion.stopReason ?? null,
        cacheWriteTokens: completion.usage.inputTokens.cacheWrite ?? 0,
        upstreamRequests: admission.used ? 1 : 0,
        deniedRequests: admission.denied,
      },
    },
  });
  controller.close();
}

/** Хвост ответа, не доехавший дельтами: реле могло получить больше, чем CLI успел напечатать. */
function reconcile(
  text: TextStream,
  final: string,
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
): void {
  if (final === text.emitted) return;
  if (final.startsWith(text.emitted)) {
    text.push(final.slice(text.emitted.length), controller);
    return;
  }
  throw new ClaudeCliError(
    "Claude CLI printed text that differs from the response it received",
  );
}

function finishOf(completion: ClaudeCompletion): LanguageModelV4FinishReason {
  const raw = completion.stopReason;
  if (completion.calls.length > 0) return { unified: "tool-calls", raw };
  if (raw === "max_tokens") return { unified: "length", raw };
  return { unified: "stop", raw };
}

/** Счётчик реле в журнале: по нему видно, что шагов столько же, сколько запросов к API. */
function report(
  model: string,
  completion: ClaudeCompletion,
  admission: Admission,
): void {
  const { total, cacheRead, cacheWrite } = completion.usage.inputTokens;
  console.error(
    `[claude] ${model}: upstream=${admission.used ? 1 : 0} denied=${admission.denied} finish=${finishOf(completion).unified} tokens=${String(total ?? 0)}/${String(completion.usage.outputTokens.total ?? 0)} cache=${String(cacheRead ?? 0)}+${String(cacheWrite ?? 0)}`,
  );
  if (!completion.hasUsage)
    console.error(
      "[claude] the response carried no token usage: this step will not show up in the usage report",
    );
}

/** doGenerate — это тот же поход, только собранный в один результат: второй дороги нет. */
async function generateCall(
  model: string,
  options: LanguageModelV4CallOptions,
  run: ClaudeRun,
): Promise<LanguageModelV4GenerateResult> {
  const { stream } = streamCall(model, options, run);
  const reader = stream.getReader();
  const content: LanguageModelV4Content[] = [];
  const warnings: SharedV4Warning[] = [];
  let text = "";
  let usage = claudeUsage(undefined);
  let finishReason: LanguageModelV4FinishReason = {
    unified: "other",
    raw: undefined,
  };
  let providerMetadata: SharedV4ProviderMetadata | undefined;
  for (;;) {
    const part = await reader.read();
    if (part.done === true) break;
    if (part.value.type === "stream-start")
      warnings.push(...part.value.warnings);
    else if (part.value.type === "text-delta") text += part.value.delta;
    else if (part.value.type === "tool-call")
      content.push({
        type: "tool-call",
        toolCallId: part.value.toolCallId,
        toolName: part.value.toolName,
        input: part.value.input,
      });
    else if (part.value.type === "finish") {
      usage = part.value.usage;
      finishReason = part.value.finishReason;
      providerMetadata = part.value.providerMetadata;
    }
  }
  if (text.length > 0) content.unshift({ type: "text", text });
  return { content, finishReason, usage, providerMetadata, warnings };
}

function asClaudeError(error: unknown): Error {
  return error instanceof Error ? error : new ClaudeCliError(String(error));
}
