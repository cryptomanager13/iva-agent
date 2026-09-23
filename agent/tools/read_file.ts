import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolveVaultToolPath } from "../lib/vault-file-search.ts";
import { vaultDirErrorText } from "../lib/vault-error.ts";

// Host-native чтение файла. Переопределяет встроенный read_file eve: читает реальный
// файл на VPS через node:fs/promises (UTF-8). Самодостаточно (eve/tools, zod, node-builtins).
//
// КОНТРАКТ ПУТЕЙ (общий с memory_search): memory_search отдаёт hits[].file как путь
// ОТНОСИТЕЛЬНО корня vault (cards/contacts/x.md) и в описании велит открывать хиты этим
// тулом — поэтому read_file принимает и абсолютный путь, и vault-относительный, резолвя
// последний от ASSISTANT_VAULT_DIR. Иначе модель получала ENOENT на путь, который ей же
// и выдали. Не менять в одностороннем порядке. Путь с лишним `vault/` от корня проекта
// тоже доходит до файла — резолвер общий с grep/glob (#242).

// Потолок вывода: большой файл не должен переполнять окно контекста за один ход.
const MAX_CHARS = 24000;
const cap = (s: string) =>
  s.length > MAX_CHARS
    ? {
        content:
          s.slice(0, MAX_CHARS) +
          "\n…(усечено; используй offset/limit для остального)",
        capped: true,
      }
    : { content: s, capped: false };

export default defineTool({
  description:
    "Прочитать UTF-8 файл хоста. path — абсолютный или от корня vault. " +
    "offset (1-based) и limit — диапазон строк; " +
    "возвращает { path, content, lines, truncated }.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Абсолютный или от корня vault (hits[].file)"),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Первая строка, 1-based"),
    limit: z.number().int().positive().optional().describe("Максимум строк"),
  }),
  async execute({ path, offset, limit }) {
    let raw: string;
    try {
      raw = await readFile(resolveVaultToolPath(path), "utf8");
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null)
        return {
          path,
          content: "",
          lines: 0,
          truncated: false,
          ok: false,
          error: text,
        };
      throw error;
    }

    // Без offset/limit — отдаём файл целиком (с потолком по символам).
    if (offset === undefined && limit === undefined) {
      const { content, capped } = cap(raw);
      return {
        path,
        content,
        lines: raw.length === 0 ? 0 : raw.split("\n").length,
        truncated: capped,
      };
    }

    const allLines = raw.split("\n");
    const start = offset ? offset - 1 : 0;
    const end = limit ? start + limit : allLines.length;
    const slice = allLines.slice(start, end);
    const { content, capped } = cap(slice.join("\n"));
    return {
      path,
      content,
      lines: slice.length,
      truncated: capped || end < allLines.length || start > 0,
    };
  },
});
