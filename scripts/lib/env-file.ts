// Surgical .env editor for the Telegram bridge (/model, /think).
// Unlike scripts/setup/config-file.ts's writeEnvFile (full rewrite in a fixed key order, drops comments),
// this edits lines in place: comments, blank lines, unknown keys and order survive.
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { throughLink } from "./link-target.ts";

// Locator, not a parser: upsertEnv edits lines in place and needs to know which line
// carries which key. Values are never read out of it — that is parseEnv's job alone.
const KEY_LINE_RE = /^\s*([A-Z0-9_]+)\s*=/;

type EnvValues = Record<string, string>;

/**
 * Почему `.env` не может хранить это значение, или null - для безопасного подмножества.
 *
 * `newline` - перевод строки; `control` - NUL или другой управляющий символ; `non-ascii` - за пределами ASCII;
 * `special` - решётка, кавычка, обратная кавычка или обратный слэш; `edge-space` -
 * пробел или табуляция по краям.
 */
export type EnvValueRejection =
  "newline" | "control" | "non-ascii" | "special" | "edge-space";

/** Человеческая причина отказа - для сообщений CLI и мастера. */
export const ENV_VALUE_PROBLEM: Record<EnvValueRejection, string> = {
  newline: "a newline",
  control: "a control character (or NUL)",
  "non-ascii": "a character outside ASCII",
  special: "one of # \" ' ` \\",
  "edge-space": "a leading or trailing space",
};

interface AtomicWriteHooks {
  beforeRename?: (temporaryPath: string) => void;
  beforeDirectorySync?: (parentPath: string) => void;
}

interface DurabilityError extends Error {
  code: "EENV_DURABILITY";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

/**
 * Parse .env text → {KEY: value}, exactly as the agent process will see it.
 *
 * The service starts through `node --env-file=.env`, so `parseEnv` from node:util is
 * not one more dialect among several — it is the runtime's own parser. A hand-written
 * regex here would read `#` past a comment and unbalanced quotes differently, and the
 * owner would be shown a key the provider never receives.
 */
export function parseEnvText(text: unknown): EnvValues {
  // Spread: parseEnv hands back a null-prototype object, and callers treat the result
  // as an ordinary record (spread into process.env, deep-compare in tests).
  return { ...parseEnv(String(text)) } as EnvValues;
}

/**
 * Безопасное подмножество значений `.env`.
 *
 * Файл читают ДВА парсера, и на боевой машине старший - не тот, что ожидается:
 * юниты несут и `EnvironmentFile=` (scripts/cli/systemd.ts, deploy/*.service), и
 * `node --env-file`, а унаследованное от systemd окружение `--env-file` уже не
 * перезаписывает. Значит значение обязано читаться ОДИНАКОВО обоими, и записываем мы
 * только то, что у обоих означает само себя без кавычек:
 *
 *   - `#` - node (util.parseEnv) обрывает незакавыченное значение на решётке,
 *     systemd (формат от POSIX-шелла) оставляет её в значении;
 *   - `"` `'` `` ` `` - оба снимают кавычки, шелл на `` ` `` ещё и подставляет вывод
 *     команды, если файл кто-то выполнит через `source`;
 *   - `\` - systemd разворачивает обратный слэш по правилам POSIX (`\x` → `x`),
 *     node оставляет его литералом (systemd/systemd#10659);
 *   - пробел и табуляция по краям - оба обрезают их у незакавыченного значения;
 *   - управляющие символы - systemd их отвергает, а NUL обрывает чтение файла у node
 *     (в памяти `parseEnv` его сохраняет, поэтому проверять надо по символам, а не
 *     прогоном через parseEnv);
 *   - не-ASCII - ни та, ни другая документация поведения не обещает.
 *
 * Внутренние пробелы оставлены: незакавыченному значению оба парсера обрезают только
 * края. Всё остальное из печатного ASCII оба отдают дословно, поэтому кавычки при
 * записи не нужны вовсе - и `grep … | cut -d=` в install.sh продолжает читать файл.
 */
export function envValueRejection(value: string): EnvValueRejection | null {
  return (
    textRejection(value) ??
    (/["'`#\\]/u.test(value) ? "special" : null) ??
    (/^[ \t]|[ \t]$/u.test(value) ? "edge-space" : null)
  );
}

/**
 * То, что негодно в значении при любом обрамлении: кавычки от этих символов не спасают.
 * Перевод строки - отдельной причиной: владельцу надо сказать «вставьте одной строкой»,
 * а не «управляющий символ».
 */
function textRejection(value: string): EnvValueRejection | null {
  if (/[\n\r]/u.test(value)) return "newline";
  // eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет проверки.
  if (/[\u0000-\u001f\u007f]/u.test(value)) return "control";
  if (/[^\u0020-\u007e]/u.test(value)) return "non-ascii";
  return null;
}

/**
 * Текст внутри кавычек, если значение закавычено ЦЕЛИКОМ и оба парсера снимут кавычки
 * одинаково; иначе null.
 *
 * Проверено дочерним `node --env-file` (`scripts/env-runtime-agreement.test.ts`):
 * у целиком закавыченного значения он отдаёт ровно то, что внутри - вместе с решёткой,
 * краевыми пробелами и чужой кавычкой. Systemd в `EnvironmentFile=` снимает кавычки по
 * тем же правилам POSIX-шелла (systemd.exec).
 *
 * Что НЕ считается снятием кавычек обоими и потому сюда не попадает:
 *   - обратный слэш внутри двойных кавычек: node разворачивает `\n` в перевод строки,
 *     systemd применяет POSIX-правила (systemd/systemd#10659) - расхождение;
 *   - текст после закрывающей кавычки (`K="a" tail`): node берёт только закавыченное,
 *     шелл склеил бы всё;
 *   - незакрытая кавычка и кавычки не по краям: обычные символы значения.
 */
const FULLY_QUOTED = /^[ \t]*(?:"([^"\\]*)"|'([^']*)')[ \t]*$/u;

export function quotedEnvValue(raw: string): string | null {
  const match = FULLY_QUOTED.exec(raw);
  return match ? (match[1] ?? match[2] ?? "") : null;
}

/**
 * Причина, по которой строку уже существующего `.env` сервис и команда прочитают
 * по-разному, или null. От `envValueRejection` отличается одним: то правило судит
 * значение, которое мы САМИ собираемся записать голым, а это - строку, которую кто-то
 * уже написал, в том числе в кавычках. Кавычки оба парсера снимают, поэтому судить надо
 * то, что внутри: иначе обычный `KEY="value"` объявляется расхождением.
 */
export function envLineRejection(raw: string): EnvValueRejection | null {
  const quoted = quotedEnvValue(raw);
  return quoted === null ? envValueRejection(raw) : textRejection(quoted);
}

/** Имя переменной, которое оба парсера примут за имя, а не за часть значения. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Одна строка `.env`, которую и сервис, и команда прочитают ровно этим значением. */
export function formatEnvLine(key: string, value: string): string {
  if (envKeyProblem(key))
    throw new Error(`env key ${JSON.stringify(key)} is not a name`);
  const rejection = envValueRejection(value);
  if (rejection)
    throw new Error(
      `env value for ${key} has ${ENV_VALUE_PROBLEM[rejection]}: .env cannot hold it the same way for the service and the CLI`,
    );
  return `${key}=${value}`;
}

/** Имя, которое годится обоим парсерам, или null. */
export function envKeyProblem(key: string): string | null {
  return KEY_RE.test(key) ? null : "a name the service cannot use";
}

/**
 * Строки уже существующего `.env`, которые сервис и команда прочитают по-разному.
 *
 * Смотреть надо на СЫРОЙ текст строки, а не на разобранное значение: `parseEnv`
 * обрывает `KEY=ab#cd` до `ab`, и по разобранному значению расхождение уже не видно -
 * ровно тот случай, ради которого всё и затевалось. Значения наружу не отдаются, только
 * имена и причины: в значениях секреты.
 */
export function ambiguousEnvLines(
  text: string,
): Array<{ key: string; problem: string }> {
  const found: Array<{ key: string; problem: string }> = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(#|;|$)/u.test(line)) continue;
    const match = /^\s*(?:export\s+)?([^\s=]+)\s*=(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    const rejection = envLineRejection(raw);
    const problem =
      envKeyProblem(key) ??
      (rejection === null ? null : ENV_VALUE_PROBLEM[rejection]);
    if (problem) found.push({ key, problem });
  }
  return found;
}

/** Read .env into {KEY: value}; {} when the file is missing. */
export async function readEnvValues(path: string): Promise<EnvValues> {
  try {
    return parseEnvText(await readFile(path, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return {};
    throw error;
  }
}

// Base env refreshed with the current .env file: file values win, base-only keys survive.
// For long-running processes (the Telegram bridge) whose process.env snapshot goes stale
// after the /model wizard edits .env — display code must read through this, not process.env.
export async function readEnvFresh(
  path: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  return { ...base, ...(await readEnvValues(path)) };
}

/**
 * Replace an env file atomically.
 *
 * The old file is protected before any secret is staged. The replacement is a
 * unique 0600 file in the same directory. The file is fsynced before rename,
 * then the parent directory is fsynced so the rename survives a crash.
 */
export function writeEnvAtomicSync(
  linkOrPath: string,
  text: unknown,
  { beforeRename, beforeDirectorySync }: AtomicWriteHooks = {},
): void {
  // A version directory borrows `.env` from the installation through a symlink,
  // and a rename replaces the link rather than following it - which would turn
  // shared configuration into a copy that the next update drops.
  const path = throughLink(linkOrPath);
  if (existsSync(path)) chmodSync(path, 0o600);
  const parent = dirname(path);
  const tmp = join(
    parent,
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    const fileFd = openSync(tmp, "wx", 0o600);
    try {
      fchmodSync(fileFd, 0o600);
      writeFileSync(fileFd, String(text), "utf8");
      fsyncSync(fileFd);
    } finally {
      closeSync(fileFd);
    }
    beforeRename?.(tmp);
    renameSync(tmp, path);

    try {
      beforeDirectorySync?.(parent);
      const directoryFd = openSync(parent, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (cause) {
      const error = new Error(
        `env file was replaced, but parent directory fsync failed; new bytes are live and crash durability is unconfirmed: ${(cause as Error).message}`,
        { cause },
      ) as DurabilityError;
      error.code = "EENV_DURABILITY";
      throw error;
    }
  } catch (error) {
    try {
      rmSync(tmp);
    } catch {
      // Failure to remove a missing or inaccessible temp file must preserve the original error.
    }
    throw error;
  }
}

// Upsert keys in .env: updates = {KEY: string | null} (null ⇒ drop the line).
// First matching line is replaced in place, duplicates are dropped, missing keys are
// appended at the end. Every line goes through formatEnvLine, so a value the runtime
// could not read back (a multiline paste of a mangled API key, mixed quotes) throws
// before anything is written, rather than corrupting .env. Write is atomic (tmp +
// rename), and every resulting .env is 0600 because it holds secrets.
export async function upsertEnv(
  path: string,
  updates: Record<string, string | null>,
): Promise<void> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    /* no file yet - create from scratch */
  }
  const lines = text.length ? text.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline re-added below
  const pending = new Map<string, string | null>(
    Object.entries(updates).map(([k, v]) => [
      k,
      v == null ? null : String(v).trim(),
    ]),
  );
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(KEY_LINE_RE);
    const k = m?.[1];
    if (k && pending.has(k)) {
      const v = pending.get(k)!;
      pending.delete(k); // duplicates of the same key are dropped
      if (v !== null) out.push(formatEnvLine(k, v));
      continue;
    }
    // A later duplicate of an already-handled deleted/replaced key: pending no longer has it — drop.
    if (k && k in updates && !pending.has(k)) continue;
    out.push(line);
  }
  for (const [k, v] of pending) if (v !== null) out.push(formatEnvLine(k, v));
  writeEnvAtomicSync(path, out.join("\n") + "\n");
}
