import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
  globToRegExp,
  resolveVaultToolRoot,
  walkFiles,
} from "../lib/vault-file-search.ts";

// Host-native grep. Переопределяет встроенный grep eve: regex-поиск по содержимому
// реальных файлов на ФС VPS (node:fs + RegExp). Обход и резолв корня общие с glob.

interface Match {
  file: string;
  line: number;
  text: string;
}

const MAX_MATCHES = 1000;

async function filesAt(root: string): Promise<string[]> {
  const info = await stat(root);
  return info.isFile() ? [root] : walkFiles(root);
}

async function readLines(file: string): Promise<string[] | null> {
  try {
    return (await readFile(file, "utf8")).split("\n");
  } catch {
    return null;
  }
}

async function matchesInFile(
  file: string,
  expression: RegExp,
): Promise<Match[]> {
  const lines = await readLines(file);
  if (lines === null) return [];
  const matches: Match[] = [];
  for (let index = 0; index < lines.length; index++) {
    expression.lastIndex = 0;
    if (!expression.test(lines[index])) continue;
    const text =
      lines[index].length > 300
        ? `${lines[index].slice(0, 300)}…`
        : lines[index];
    matches.push({ file, line: index + 1, text });
  }
  return matches;
}

async function findMatches(
  files: string[],
  root: string,
  expression: RegExp,
  globExpression: RegExp | null,
): Promise<{ count: number; truncated: boolean; matches: Match[] }> {
  const matches: Match[] = [];
  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (globExpression !== null && !globExpression.test(relativePath)) continue;
    const remaining = MAX_MATCHES - matches.length;
    const additions = await matchesInFile(file, expression);
    matches.push(...additions.slice(0, remaining));
    if (additions.length >= remaining)
      return { count: matches.length, truncated: true, matches };
  }
  return { count: matches.length, truncated: false, matches };
}

export default defineTool({
  description:
    "Regex-поиск по файлам хоста. path — абсолютный или от корня vault файл либо " +
    "директория (по умолчанию корень vault, рекурсивно); glob фильтрует по пути; " +
    "flags — RegExp-флаги ('i', 'm'). " +
    "Возвращает { file, line, text }, до 1000; бинарные пропускаются.",
  inputSchema: z.object({
    pattern: z.string().min(1).describe("Регулярное выражение"),
    path: z.string().optional().describe("Абсолютный или от корня vault путь"),
    glob: z.string().optional().describe("Glob-фильтр, напр. **/*.ts"),
    flags: z.string().optional().describe("Напр. 'i' или 'm'"),
  }),
  async execute({ pattern, path, glob, flags }) {
    const root = resolveVaultToolRoot(path);
    return findMatches(
      await filesAt(root),
      root,
      new RegExp(pattern, flags ?? ""),
      glob ? globToRegExp(glob) : null,
    );
  },
});
