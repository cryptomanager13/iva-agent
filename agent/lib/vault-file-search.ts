import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveVaultDir } from "@iva/vault-dir";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".cache",
]);

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split(sep).join("/");
  let expression = "";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        expression += "(?:.*)";
        index++;
        if (normalized[index + 1] === "/") index++;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(char)) {
      expression += `\\${char}`;
    } else {
      expression += char;
    }
  }
  return new RegExp(`^${expression}$`);
}

// Относительный путь тулов чтения (read_file, grep, glob) считается от корня vault, а
// write_file и bash — от корня проекта. Модель путает контракты и подаёт `vault/daily/x.md`,
// который от корня vault становится vault/vault/daily/x.md → ENOENT (#199, #242). Если
// такого пути в vault нет, а тот же путь от рабочего каталога указывает ВНУТРЬ vault,
// берём его: оба прочтения ведут в один vault, настоящий vault/vault/ по-прежнему первичен.
export function resolveVaultToolPath(path: string): string {
  if (isAbsolute(path)) return path;
  const vault = resolveVaultDir(process.cwd());
  const fromVault = resolve(vault, path);
  if (existsSync(fromVault)) return fromVault;
  const fromCwd = resolve(process.cwd(), path);
  const inside = relative(vault, fromCwd);
  const withinVault =
    inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  return withinVault && existsSync(fromCwd) ? fromCwd : fromVault;
}

export function resolveVaultToolRoot(path?: string): string {
  return path === undefined
    ? resolveVaultDir(process.cwd())
    : resolveVaultToolPath(path);
}

async function walk(
  dir: string,
  out: string[],
  visited: Set<string>,
): Promise<void> {
  let canonical: string;
  try {
    canonical = await realpath(dir);
  } catch {
    return;
  }
  if (visited.has(canonical)) return;
  visited.add(canonical);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(full);
        isDirectory = info.isDirectory();
        isFile = info.isFile();
      } catch {
        continue;
      }
    }
    if (isDirectory) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await walk(full, out, visited);
    } else if (isFile) {
      out.push(full);
    }
  }
}

export async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files, new Set());
  return files;
}
