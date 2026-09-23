// Где сервис Iva ищет Claude Code CLI и как его поставить без root. Одно правило на обе
// половины: рантайм (agent/lib/claude-cli.ts) ищет по PATH своего процесса, а доктор и
// мастер (scripts/lib/claude-cli-status.ts) — по тому PATH, который получит сервис.
// Пакет, а не agent/lib: `iva doctor` обязан грузиться без authored tree (ADR-0003).
import { accessSync, constants, statSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** PATH каждого юнита после каталога node; `%h` — домашний каталог, его раскрывает systemd. */
export const SERVICE_PATH_TAIL = "%h/.local/bin:/usr/local/bin:/usr/bin:/bin";

/** PATH сервиса, каким его увидит процесс под юнитом. */
export function servicePath(nodeBinDir: string, home: string): string {
  return `${nodeBinDir}:${SERVICE_PATH_TAIL.replaceAll("%h", home)}`;
}

/** Установка в `~/.local`: бинарь ляжет в `~/.local/bin`, а он уже в PATH сервиса. */
export const CLAUDE_INSTALL_COMMAND =
  "npm install -g --prefix ~/.local @anthropic-ai/claude-code";

/** Подсказка установки с именем пользователя: ставить надо под тем, кто запускает сервис. */
export function claudeInstallHint(): string {
  return `as ${userInfo().username}: ${CLAUDE_INSTALL_COMMAND}`;
}

/**
 * Почему CLI не найден, с PATH, по которому искали: одна строка для доктора, мастера и
 * рантайма. Заданный `CLAUDE_COMMAND` называется сам; иначе — подсказка установки.
 */
export function claudeNotFound(
  command: string | undefined,
  pathValue: string | undefined,
): string {
  const configured = (command ?? "").trim();
  const where = `PATH: ${pathValue ?? ""}`;
  return configured
    ? `CLAUDE_COMMAND=${configured} is not found or not executable (${where})`
    : `Claude Code CLI not found (${where}) — install it on the server ${claudeInstallHint()} (or point CLAUDE_COMMAND at the binary)`;
}

/**
 * Команда CLI: `CLAUDE_COMMAND` (путь или имя, дальше аргументы через пробел; путь с
 * пробелом не поддерживается) или `claude`. Голова ищется по переданному PATH; не найдена —
 * null.
 */
export function resolveClaude(
  command: string | undefined,
  pathValue: string | undefined,
): string[] | null {
  const configured = (command ?? "").trim();
  const [head, ...args] = configured ? configured.split(/\s+/u) : ["claude"];
  const found = which(head, pathValue ?? "");
  return found === null ? null : [found, ...args];
}

function which(head: string, pathValue: string): string | null {
  if (isAbsolute(head)) return executable(head) ? head : null;
  for (const dir of pathValue.split(delimiter)) {
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
