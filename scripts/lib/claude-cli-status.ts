// Живой вендор `claude`: ключа в .env нет — Ива зовёт установленный и залогиненный
// Claude Code CLI на той же машине. Здесь половина CLI: статус входа, живой список
// моделей из рукопожатия initialize и одна проба выбранной модели. agent/ этот модуль
// не импортирует (ADR-0003): та половина задаёт CLI те же вопросы своей рукой, а общий
// у них только контракт — CLAUDE_COMMAND, CLAUDE_MODEL, CLAUDE_CONTEXT_WINDOW.
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export type ClaudeEnv = Readonly<Record<string, string | undefined>>;

/** Строка модели для экранов и .env — та же форма, что ModelOption каталога: сюда её
 *  приносит чужая рука, чтобы этот модуль не зависел от каталога (цикл импортов).
 *  `label` — подпись кнопки; в .env пишется `id`. */
export interface ClaudeModelOption {
  id: string;
  label?: string;
  reasoningLevels: string[];
}

/** Три модели экрана «Модель · Claude», в порядке кнопок. Псевдонимы пикера
 *  (`default`, `opus[1m]`) и Haiku сюда не входят: в .env только эти id. */
const CLAUDE_MODEL_CHOICES = [
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
] as const;

/** Подпись известной модели; чужой id возвращается как есть, чтобы список не врал. */
export function claudeModelLabel(id: string): string {
  return CLAUDE_MODEL_CHOICES.find((choice) => choice.id === id)?.label ?? id;
}

function claudeChoice(id: string): ClaudeModelOption {
  return { id, label: claudeModelLabel(id), reasoningLevels: [] };
}

/** Установка и вход живут в шелле сервера: в Telegram их за владельца не сделать. */
export const CLAUDE_INSTALL_HINT = "npm install -g @anthropic-ai/claude-code";
export const CLAUDE_LOGIN_HINT = "claude auth login";

// `auth status` читает локальное хранилище и отвечает мгновенно; рукопожатие поднимает
// CLI целиком; проба разговаривает с моделью — ей нужен запас побольше.
const STATUS_TIMEOUT_MS = 20_000;
const MODELS_TIMEOUT_MS = 40_000;
const PROBE_TIMEOUT_MS = 90_000;
/** Потолок вывода одного запуска: ответ пиккера — килобайты, а стрим хода — нет. */
const OUTPUT_LIMIT = 64_000;
/** Рукопожатию модель не нужна (запросов к Anthropic оно не делает), но CLI требует имя:
 *  берём короткий псевдоним, который есть у любого плана. */
const HANDSHAKE_MODEL = "sonnet";

export class ClaudeCliError extends Error {
  declare readonly code: string;

  constructor(
    code: string,
    message: string,
    { cause }: { cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "ClaudeCliError";
    this.code = code;
  }
}

export interface ClaudeStatus {
  /** Бинарь нашёлся и запускается. */
  installed: boolean;
  /** `claude auth status` ответил `loggedIn: true`. */
  loggedIn: boolean;
  /** План из `subscriptionType`; пустая строка — CLI его не назвал. */
  plan: string;
  /** Имя чужой переменной авторизации в окружении, или null. Значение не печатается. */
  conflict: string | null;
  /** Готовность одним ответом: экраны не повторяют три условия каждый по-своему. */
  ready: boolean;
  /** Что сделать владельцу; пусто, когда всё готово. */
  hint: string;
}

export interface ClaudeCliOptions {
  /** Таймаут одного запуска: тесты не ждут минуту ради ветки «тишина». */
  timeoutMs?: number;
}

interface ClaudeRun {
  stdout: string;
  stderr: string;
  /** Таймаут или отказ запуска: ответа CLI нет вовсе. */
  failed: boolean;
}

type ClaudeRunner = (
  command: readonly string[],
  options: {
    env: ClaudeEnv;
    input: string;
    timeoutMs: number;
    cwd: string;
  },
) => Promise<ClaudeRun>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

// ── бинарь ────────────────────────────────────────────────────────────────────

/** Путь к исполняемому файлу из PATH. Пустая строка и мусор в PATH не считаются. */
function which(head: string, env: ClaudeEnv): string | null {
  if (isAbsolute(head)) return executable(head) ? head : null;
  const path = env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, head);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** Файл, который можно запустить: каталог с правом входа программой не является. */
function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Команда CLI: `CLAUDE_COMMAND` (одно слово или строка с аргументами) или `claude` из
 * PATH. Сервис systemd несёт PATH без каталога node, а `claude` — npm-скрипт с шебангом
 * `env node`, поэтому каталог работающего node ищем и сами.
 */
export function claudeBinary(env: ClaudeEnv = process.env): string[] | null {
  const configured = (env.CLAUDE_COMMAND ?? "").trim();
  const [head = "", ...rest] = configured
    ? configured.split(/\s+/u)
    : ["claude"];
  if (!head) return null;
  const found = which(head, env) ?? which(head, searchPath(env));
  if (!found) return null;
  return [found, ...rest];
}

/** PATH, которым пользуемся мы: свой плюс каталог node, которым запущен этот процесс. */
function searchPath(env: ClaudeEnv): ClaudeEnv {
  return {
    ...env,
    PATH: [dirname(process.execPath), env.PATH ?? ""]
      .filter(Boolean)
      .join(delimiter),
  };
}

/** Окружение CLI: каталог node в PATH плюс всё, что дал вызывающий. */
function childEnv(env: ClaudeEnv, extra: Record<string, string> = {}) {
  return { ...env, PATH: searchPath(env).PATH ?? "", ...extra };
}

// ── запуск ────────────────────────────────────────────────────────────────────

const runClaude: ClaudeRunner = (command, { env, input, timeoutMs, cwd }) =>
  new Promise<ClaudeRun>((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: childEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      // Своя группа: таймаут забирает и детей CLI, а не только его самого.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let failed = false;
    let settled = false;
    const finish = (payload: ClaudeRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      failed = true;
      killGroup(child.pid);
      finish({ stdout, stderr, failed });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = capOutput(stdout, chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = capOutput(stderr, chunk.toString());
    });
    child.on("error", () => {
      failed = true;
      finish({ stdout, stderr, failed });
    });
    child.on("close", () => finish({ stdout, stderr, failed }));
    child.stdin?.end(input);
  });

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return; // Группы уже нет — гасить нечего.
  }
}

function capOutput(current: string, chunk: string): string {
  if (current.length >= OUTPUT_LIMIT) return current;
  return (current + chunk).slice(0, OUTPUT_LIMIT);
}

/** Временный каталог на один запуск: cwd CLI и дом для его файлов. */
async function inTempDir<T>(body: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iva-claude-cli-"));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── статус ────────────────────────────────────────────────────────────────────

/** Значения, при которых переменная означает «не включено». Правило общее с рантаймом. */
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);
/** Ключ и адрес, уводящие CLI с подписки владельца. Тот же перечень, что у рантайма в
 *  `agent/lib/claude-cli.ts`; разъедься половины — доктор объявил бы .env здоровым перед
 *  агентом, который на этом же .env отказывается делать ход. Сторожит зеркальный тест. */
const FOREIGN_AUTH = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_BASE_URL",
];

/** Чужая авторизация или чужой адрес в окружении: подписка ушла бы на чужой счёт или мимо
 *  неё вовсе. Имя переменной называем, значение — никогда. */
export function firstConflict(env: ClaudeEnv): string | null {
  for (const name of FOREIGN_AUTH) {
    if ((env[name] ?? "").length > 0) return name;
  }
  return (
    Object.keys(env)
      .sort()
      .find(
        (name) =>
          name.startsWith("CLAUDE_CODE_USE_") &&
          !OFF_VALUES.has((env[name] ?? "").toLowerCase()),
      ) ?? null
  );
}

/** Разбор строки как JSON-объекта; всё остальное — «не JSON». */
function jsonObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * JSON из вывода `claude auth status`. Настоящий CLI печатает его разложенным по строкам,
 * тесты — одной строкой, поэтому пробуем и целиком, и построчно: пустой или нечитаемый
 * вывод — «не ответил», а не выдуманный план.
 */
function parseAuthStatus(stdout: string): { loggedIn: boolean; plan: string } {
  const text = stdout.trim();
  const parsed =
    jsonObject(text) ??
    stdout
      .split("\n")
      .map((row) => jsonObject(row.trim()))
      .find((row) => row !== null) ??
    jsonObject(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!parsed) return { loggedIn: false, plan: "" };
  const plan =
    typeof parsed.subscriptionType === "string"
      ? parsed.subscriptionType.trim()
      : "";
  return { loggedIn: parsed.loggedIn === true, plan };
}

/**
 * Статус CLI: установлен ли и выполнен ли вход. Отказы не бросают исключение — каждый из
 * них это ответ экрану и доктору, а не поломка кода.
 */
async function claudeStatusRaw(
  env: ClaudeEnv,
  options: ClaudeCliOptions,
): Promise<ClaudeStatus> {
  const command = claudeBinary(env) as string[];
  const conflict = firstConflict(env);
  const result = await runClaude([...command, "auth", "status"], {
    env,
    input: "",
    timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS,
    cwd: tmpdir(),
  });
  const { loggedIn, plan } = result.failed
    ? { loggedIn: false, plan: "" }
    : parseAuthStatus(result.stdout);
  const hint = hintFor({ conflict, loggedIn });
  return {
    installed: true,
    loggedIn,
    plan,
    conflict,
    ready: loggedIn && conflict === null,
    hint,
  };
}

/**
 * Статус CLI: установлен ли и выполнен ли вход. Отказы не бросают исключение — каждый из
 * них это ответ экрану и доктору, а не поломка кода.
 */
export async function claudeStatus(
  env: ClaudeEnv = process.env,
  options: ClaudeCliOptions = {},
): Promise<ClaudeStatus> {
  return claudeBinary(env) ? claudeStatusRaw(env, options) : notInstalled();
}

const notInstalled = (): ClaudeStatus => ({
  installed: false,
  loggedIn: false,
  plan: "",
  conflict: null,
  ready: false,
  hint: `Claude Code CLI not found — install it on the server: ${CLAUDE_INSTALL_HINT} (or point CLAUDE_COMMAND at the binary)`,
});

function hintFor({
  conflict,
  loggedIn,
}: {
  conflict: string | null;
  loggedIn: boolean;
}): string {
  if (conflict)
    return `${conflict} is set in .env — the subscription works without any key or address of its own, and that variable would send the calls somewhere else. Remove the line`;
  return loggedIn
    ? ""
    : `Claude Code CLI is not signed in — run on the server: ${CLAUDE_LOGIN_HINT}`;
}

// ── живой список моделей ──────────────────────────────────────────────────────

/** Рукопожатие initialize: CLI отвечает своим пикером, не делая ни одного запроса к
 *  Anthropic, — поэтому список отражает то, что открыто этой подписке. */
const HANDSHAKE_REQUEST = `${JSON.stringify({
  type: "control_request",
  request_id: "iva-picker",
  request: { subtype: "initialize" },
})}\n`;

const HANDSHAKE_ARGS = [
  "-p",
  "--model",
  HANDSHAKE_MODEL,
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--no-session-persistence",
];

function jsonRows(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

/** Модели из рукопожатия. `null` — ответа пикера нет вовсе (это отказ, не пустой список). */
function handshakeModels(stdout: string): unknown[] | null {
  const row = jsonRows(stdout).find((r) => r.type === "control_response");
  if (!row) return null;
  const inner = isRecord(row.response) ? row.response : null;
  const body = isRecord(inner?.response) ? inner.response : null;
  const models = body?.models;
  if (!Array.isArray(models)) return [];
  return models as unknown[];
}

/** Канонический id из `resolvedModel`: суффикс `[1m]` срезается, псевдоним `value` не берётся. */
function canonicalResolved(value: unknown): string | null {
  if (!isRecord(value) || typeof value.resolvedModel !== "string") return null;
  const id = value.resolvedModel.trim().replace(/\[1m\]$/u, "");
  return CLAUDE_MODEL_CHOICES.some((choice) => choice.id === id) ? id : null;
}

/** Три модели таблицы, которые пикер реально отдал. Пустое пересечение — вшитые три. */
function choicesFromPicker(models: readonly unknown[]): ClaudeModelOption[] {
  const found = new Set<string>();
  for (const value of models) {
    const id = canonicalResolved(value);
    if (id) found.add(id);
  }
  const picked = CLAUDE_MODEL_CHOICES.filter((choice) => found.has(choice.id));
  const source = picked.length > 0 ? picked : CLAUDE_MODEL_CHOICES;
  return source.map((choice) => claudeChoice(choice.id));
}

/**
 * Живой список моделей подписки. Ошибки бросаем: вызывающий сам решает, звать ли вшитый
 * список каталога (мастер) или показать причину (экран /model).
 */
export async function listClaudeModels(
  env: ClaudeEnv = process.env,
  options: ClaudeCliOptions = {},
): Promise<ClaudeModelOption[]> {
  const command = await readyClaude(env, options);
  const result = await inTempDir((cwd) =>
    runClaude([...command, ...HANDSHAKE_ARGS], {
      env,
      input: HANDSHAKE_REQUEST,
      timeoutMs: options.timeoutMs ?? MODELS_TIMEOUT_MS,
      cwd,
    }),
  );
  const models = result.failed ? null : handshakeModels(result.stdout);
  if (!models)
    throw new ClaudeCliError(
      "catalog_unavailable",
      "the CLI answered no model picker",
    );
  return choicesFromPicker(models);
}

/** Команда CLI, готового отвечать: не установлен и не вошёл — это отказ с подсказкой. */
async function readyClaude(
  env: ClaudeEnv,
  options: ClaudeCliOptions,
): Promise<string[]> {
  const status = await claudeStatus(env, options);
  if (!status.installed) throw new ClaudeCliError("not_installed", status.hint);
  if (!status.ready) throw new ClaudeCliError("not_logged_in", status.hint);
  return claudeBinary(env) as string[];
}

// ── проба модели ──────────────────────────────────────────────────────────────

/** Муляж MCP внутри `node -e`: бандл не гарантирует соседний файл, а проба объявляет
 *  ровно один инструмент и никогда его не исполняет. */
const PROBE_MCP_SCRIPT = [
  'const manifest=[{name:"ping",description:"Health check. Call it when asked.",inputSchema:{type:"object",properties:{}}}];',
  'let buf="";',
  'process.stdin.on("data",(d)=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;let row;try{row=JSON.parse(line)}catch{continue}',
  "let result={};",
  'if(row.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"iva-probe",version:"1"}};',
  'else if(row.method==="tools/list")result={tools:manifest};',
  'else if(row.method==="tools/call")result={isError:true,content:[{type:"text",text:"Denied: tools run in Iva."}]};',
  'if("id" in row)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:row.id,result})+"\\n");}});',
].join("");

/** Тело запроса с инструментом: модель обязана его видеть — Иво всегда шлёт инструменты. */
const PROBE_TOOLS = JSON.stringify({
  tools: [
    {
      name: "mcp__iva__ping",
      description: "Health check. Call it when asked.",
      input_schema: { type: "object", properties: {} },
    },
  ],
});

const PROBE_PROMPT = "Call the ping tool.";

function probeArgs(model: string): string[] {
  const mcp = JSON.stringify({
    mcpServers: {
      iva: { command: process.execPath, args: ["-e", PROBE_MCP_SCRIPT] },
    },
  });
  return [
    "-p",
    "--model",
    model,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcp,
    "--disable-slash-commands",
    "--max-turns",
    "1",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
  ];
}

const probeFrame = () =>
  `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: PROBE_PROMPT }] },
  })}\n`;

/** Ответ модели из потока: либо текст, либо вызов нашего инструмента — оба доказывают,
 *  что модель жива и запрос с инструментами принят (как answered у OpenRouter). */
function probeAnswered(stdout: string): boolean {
  const rows = jsonRows(stdout);
  const result = rows.find((row) => row.type === "result");
  if (result?.subtype === "success") return true;
  if (result?.subtype !== "error_max_turns") return false;
  return rows.some((row) => {
    const message = isRecord(row.message) ? row.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.some(
      (block) => isRecord(block) && block.type === "tool_use",
    );
  });
}

/** Текст отказа CLI: короткий, без стека и без значений окружения. */
function probeFailure(stdout: string, stderr: string): string {
  const rows = jsonRows(stdout);
  const result = rows.find((row) => row.type === "result");
  const text = [result?.result, result?.error, stderr].find(
    (value) => typeof value === "string" && value.trim(),
  );
  return typeof text === "string"
    ? text.trim().slice(0, 300)
    : "no answer from the CLI";
}

/**
 * Живая проба выбранной модели: один запрос с инструментом. Так мастер узнаёт, что
 * модель вообще есть у подписки, а не только в списке, — до записи .env.
 */
export async function probeClaudeModel(
  model: string,
  env: ClaudeEnv = process.env,
  options: ClaudeCliOptions = {},
): Promise<ClaudeModelOption & { answered: boolean }> {
  const command = await readyClaude(env, options);
  // CLAUDE_CODE_EXTRA_BODY несёт объявление инструмента: своя рука вместо тела запроса
  // рантайма (см. agent/lib/claude-cli.ts), но тем же полем.
  const result = await inTempDir((cwd) =>
    runClaude([...command, ...probeArgs(model)], {
      env: childEnv(env, { CLAUDE_CODE_EXTRA_BODY: PROBE_TOOLS }),
      input: probeFrame(),
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      cwd,
    }),
  );
  if (!result.failed && probeAnswered(result.stdout))
    return { id: model, reasoningLevels: [], answered: true };
  throw new ClaudeCliError(
    "model_unavailable",
    result.failed
      ? "the CLI answered nothing within the timeout"
      : probeFailure(result.stdout, result.stderr),
  );
}

// ── окно контекста ────────────────────────────────────────────────────────────

// Окна моделей подписки: миллион у fable/opus/sonnet, двести тысяч у haiku. Та же
// таблица стоит у рантайма в agent/provider.ts — разъехаться им нельзя, поэтому
// правило одно на оба случая и живёт рядом с именами моделей, которые его знают.
const CLAUDE_CONTEXT_WINDOWS: ReadonlyArray<[RegExp, string]> = [
  [/claude-haiku/u, "200000"],
];
const CLAUDE_DEFAULT_CONTEXT_WINDOW = "1000000";

/** Окно контекста выбранной модели: мастер пишет его в .env, чтобы компактация считала
 *  порог от настоящего окна, а не от круглого числа побольше. */
export function claudeContextWindow(model: string): string {
  for (const [pattern, window] of CLAUDE_CONTEXT_WINDOWS) {
    if (pattern.test(model)) return window;
  }
  return CLAUDE_DEFAULT_CONTEXT_WINDOW;
}
