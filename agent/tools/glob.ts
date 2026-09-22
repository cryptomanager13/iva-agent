import { defineTool } from "eve/tools";
import { z } from "zod";
import { relative, sep } from "node:path";
import {
  globToRegExp,
  resolveVaultToolRoot,
  walkFiles,
} from "../lib/vault-file-search.ts";

// Host-native glob. Переопределяет встроенный glob eve: ищет файлы на реальной ФС VPS.
// fast-glob в node_modules отсутствует, поэтому реализовано через рекурсивный обход fs
// и собственный матчер glob-паттернов. Корень резолвится так же, как у read_file.

export default defineTool({
  description:
    "Glob-поиск файлов: **, * и ?. По умолчанию ищет от корня vault; cwd — " +
    "абсолютный или от корня vault. .git/node_modules/dist пропускаются.",
  inputSchema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe("Glob-паттерн, напр. **/*.ts или daily/*.md"),
    cwd: z.string().optional().describe("Абсолютный или от корня vault путь"),
  }),
  async execute({ pattern, cwd }) {
    const root = resolveVaultToolRoot(cwd);
    const all = (await walkFiles(root)).map((file) =>
      relative(root, file).split(sep).join("/"),
    );
    const re = globToRegExp(pattern);
    const matches = all.filter((p) => re.test(p)).sort();
    return matches;
  },
});
