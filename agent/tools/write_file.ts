import { defineTool } from "eve/tools";
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../lib/fs-atomic.js";
import { resolveVaultDir } from "@iva/vault-dir";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import { commitVaultWrite } from "../lib/vault-commit.ts";

// Host-native запись файла. Переопределяет встроенный write_file eve: пишет реальный
// файл на VPS через каноническую атомарную запись, создавая родительские директории.
//
// Единственное ограничение: перезапись СУЩЕСТВУЮЩЕЙ карточки в <vault>/cards/** запрещена —
// это полная замена файла, из-за которой терялись поля (tier/relevance/phone…) и старый текст.
// Такие правки идут через write_card (он сливает). Всё остальное (vault/CORE.md, daily,
// новые файлы в cards/) write_file пишет как раньше — см. instructions/10-map.md.

type PathProbe =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

// Сравниваем РЕАЛЬНЫЕ пути (realpath), а не лексические: симлинк vault/alias → cards
// не должен обходить гард. Три исхода, а не два: «нет» и «не смог посмотреть» ведут к
// противоположным решениям, и склеивать их нельзя.
function probe(path: string): PathProbe {
  try {
    return { kind: "path", path: realpathSync(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable", reason: (error as Error).message };
  }
}

type CardVerdict =
  { readonly card: boolean } | { readonly undecidable: string };

// Решить «карточка или нет» можно, только зная, где вольт. Раньше нерезолвимый вольт
// читался как «не карточка», то есть гвард открывался наружу и молчал: путь к вольту по
// умолчанию относительный (`vault`), так что любой процесс с другим рабочим каталогом
// затирал карточку целиком и возвращал модели ok:true.
function cardVerdict(path: string): CardVerdict {
  const abs = resolve(path);
  // Файла нет — перезаписывать нечего, и где вольт, знать не требуется.
  if (!existsSync(abs)) return { card: false };

  const vault = resolveVaultDir(process.cwd());
  const cardsPath = join(vault, "cards");
  const root = probe(vault);
  if (root.kind === "absent")
    return {
      undecidable: `каталога вольта ${vault} нет (ASSISTANT_VAULT_DIR задан относительно рабочего каталога?)`,
    };
  if (root.kind === "unreadable") return { undecidable: root.reason };

  const cards = probe(join(root.path, "cards"));
  // Вольт на месте, а cards/ в нём ещё нет — защищать нечего.
  if (cards.kind === "absent") return { card: false };
  if (cards.kind === "unreadable") return { undecidable: cards.reason };

  const real = probe(abs);
  // Исчез между проверкой и резолвом — перезаписывать снова нечего.
  if (real.kind === "absent") return { card: false };
  if (real.kind === "unreadable")
    return { undecidable: `${cardsPath}: ${real.reason}` };

  return {
    card: real.path === cards.path || real.path.startsWith(cards.path + sep),
  };
}

export default defineTool({
  description:
    "Записать файл (UTF-8) на хост; директории создаются, файл перезаписывается целиком. " +
    "Возвращает { ok, path, bytes }. " +
    "Карточку vault/cards/** нельзя — используй write_card.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Абсолютный путь"),
    content: z.string().describe("Содержимое (UTF-8)"),
  }),
  async execute({ path, content }) {
    let verdict: CardVerdict;
    try {
      verdict = cardVerdict(path);
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null) return { ok: false, path, error: text };
      throw error;
    }
    if ("undecidable" in verdict) {
      const error = `не могу проверить ${join(resolveVaultDir(process.cwd()), "cards")}: ${verdict.undecidable}`;
      console.error(`[write_file] ${error}`);
      return { ok: false, path, error };
    }
    if (verdict.card) {
      return {
        ok: false,
        path,
        error:
          "Карточка уже существует — write_file затёр бы её целиком (поля вне схемы и старый текст). " +
          "Используй write_card: он сливает новое содержимое со старым.",
      };
    }
    await writeFileAtomic(path, content);
    // Внутри vault файл - часть памяти, и правка оставляет след в её истории; вне vault
    // шов молча пропускает путь.
    await commitVaultWrite(`file ${fileRel(path)}: write`, [path]);
    return { ok: true, path, bytes: Buffer.byteLength(content, "utf8") };
  },
});

/** Путь файла для сообщения коммита: от vault, с прямыми слэшами. Вне vault он не попадёт
 * ни в одно сообщение - шов такой путь не коммитит. */
function fileRel(path: string): string {
  return relative(resolveVaultDir(process.cwd()), resolve(path))
    .split(sep)
    .join("/");
}
