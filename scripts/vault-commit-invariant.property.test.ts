// PBT инварианта шва коммита памяти. Класс дефекта, который дважды возвращался через разные
// двери («коммит забирает чужое» и «коммит уходит не в тот репозиторий»), проверяется не
// дверью, а инвариантом: под произвольными именами путей, произвольным чужим состоянием
// индекса, произвольным окружением процесса и произвольным исходом коммита после записи
// обязано быть верно всё сразу:
//   (а) новый коммит либо один и лежит в репозитории самого vault, либо его нет и в журнале
//       ровно одна строка с причиной;
//   (б) коммит называет ровно пути записи и ни одного другого;
//   (в) соседний чужой репозиторий не тронут: HEAD, индекс, дерево и незакоммиченное;
//   (г) чужая работа в vault та же по `status --porcelain=v2` и `ls-files -s` - для всех
//       путей, кроме путей записи; при несостоявшемся коммите и для путей записи: их записи
//       индекса и флаги (intent-to-add живёт только в них);
//   (д) запись на диск состоялась всегда.
// Воспроизведение провала: seed печатается перед прогоном, подставь его в
// fc.assert(prop, { seed }).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fc from "fast-check";

import "./lib/ts-esm-hooks.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = join(REPO, "vault-template", "schema.json");
const SEED = Number(process.env.IVA_VAULT_COMMIT_SEED ?? 20_261_001);
/** Прогонов по умолчанию: 50 - около десяти секунд, файл идёт в каждом полном прогоне и в
 * проверке перед пушем (у неё минута на все тронутые файлы). Приёмка шва гоняет 200:
 * `IVA_VAULT_COMMIT_RUNS=200`. Оба известных контрпримера класса ловятся до 25-го прогона. */
const RUNS = Number(process.env.IVA_VAULT_COMMIT_RUNS ?? 50);
process.env.ASSISTANT_TIMEZONE = "UTC";

type Kind = "card" | "file" | "direct";
type Foreign =
  | "none"
  | "staged-new"
  | "staged-modified"
  | "staged-deleted"
  | "staged-rename"
  | "partial-hunk"
  | "intent-to-add"
  | "untracked"
  | "modified-tracked"
  | "same-path-staged"
  | "sibling-name";
type EnvKind =
  | "clean"
  | "GIT_DIR"
  | "GIT_WORK_TREE"
  | "GIT_INDEX_FILE"
  | "GIT_OBJECT_DIRECTORY"
  | "GIT_COMMON_DIR"
  | "GIT_NAMESPACE"
  | "GIT_CEILING_DIRECTORIES";
type Outcome = "commit" | "hook" | "ignored";

type WriteCase = {
  readonly env: EnvKind;
  readonly foreign: Foreign;
  readonly kind: Kind;
  readonly name: string;
  readonly outcome: Outcome;
  readonly title: string;
};

/** Своя личность для git: две записи конфига на каждый прогон не нужны. */
const IDENTITY = [
  "-c",
  "user.email=owner@example.com",
  "-c",
  "user.name=Owner",
];

/** Имена, на которых git-аргументы перестают быть литералами: `*`, `?`, `[`, `]`, ведущий
 * `-`, `:`, `!`, обратный слэш, кавычки, пробелы и кириллица. */
const NAME_PARTS = [
  "отчёт",
  "план",
  "ёлка",
  "-",
  "*",
  "?",
  "[",
  "]",
  ":",
  "!",
  "\\",
  '"',
  "'",
  " ",
];

const nameArb = fc
  .array(fc.constantFrom(...NAME_PARTS), { maxLength: 3, minLength: 1 })
  .map((parts) => `${parts.join("")}.md`);

const writeCaseArb: fc.Arbitrary<WriteCase> = fc
  .record({
    env: fc.constantFrom<EnvKind>(
      "clean",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_CEILING_DIRECTORIES",
    ),
    foreign: fc.constantFrom<Foreign>(
      "none",
      "staged-new",
      "staged-modified",
      "staged-deleted",
      "staged-rename",
      "partial-hunk",
      "intent-to-add",
      "untracked",
      "modified-tracked",
      "same-path-staged",
      "sibling-name",
    ),
    kind: fc.constantFrom<Kind>("card", "file", "direct"),
    name: nameArb,
    outcome: fc.constantFrom<Outcome>("commit", "hook", "ignored"),
    title: fc.constantFrom("Карточка", "Ёлка", "Планёрка", "Отчёт"),
  })
  .map((spec) =>
    // Сосед под глобом есть смысл заводить только тогда, когда имя пути записи само глоб:
    // иначе случай ничего не проверяет и дыра в литеральных путях остаётся незамеченной.
    spec.foreign === "sibling-name" && !/[?*[]/u.test(spec.name)
      ? { ...spec, name: `${spec.name.slice(0, -".md".length)}*.md` }
      : spec,
  );

/** Своё окружение для проверок: `GIT_DIR` и родня из сценария не должны уводить и мои git. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  env.GIT_LITERAL_PATHSPECS = "1";
  return env;
}

/** git глазами проверяющего: литеральные пути, никакого чужого окружения. */
function git(args: readonly string[], cwd: string): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: cleanEnv(),
    }).trim();
  } catch (error) {
    return `ERR:${stderrOf(error)}`;
  }
}

function stderrOf(error: unknown): string {
  const text = (error as { stderr?: unknown }).stderr;
  return typeof text === "string" ? text : "";
}

/** Отпечаток репозитория побайтно: HEAD, индекс, дерево и конфиг. Читается файлами, а не
 * git: чужие репозитории проверяются на каждом прогоне, и лишние спавны здесь дороже всего, а
 * байтовое сравнение строже - git не трогаем, значит и следа не оставляем. */
function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (one, other) => (one.name < other.name ? -1 : 1),
    )) {
      const full = join(path, entry.name);
      hash.update(relative(dir, full));
      if (entry.isDirectory()) visit(full);
      else hash.update(readFileSync(full));
    }
  };
  visit(dir);
  return hash.digest("hex");
}

/** Состояние путей: `status --porcelain=v2` несёт и индекс (режим, блоб, стадию записи), и
 * дерево, и помету «добавлено без содержимого» - одного вызова хватает на все пункты. */
function stateOf(dir: string, paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return git(
    [
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v2",
      "-z",
      "-uall",
      "--",
      ...paths,
    ],
    dir,
  );
}

/** Только записи индекса по путям записи: дерево у них меняется законно (инструмент пишет
 * файл), а индекс обязан вернуться как был. Из записи `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI>`
 * берём столбец индекса, режимы и блобы HEAD и индекса; строки `?` - факт дерева, не индекса. */
function indexOf(dir: string, paths: readonly string[]): string {
  const records: string[] = [];
  for (const record of stateOf(dir, paths).split("\0").filter(Boolean)) {
    if (record.startsWith("?")) continue;
    const field = record.split(" ");
    const indexOnly =
      field.length >= 8
        ? [field[1][0], field[3], field[4], field[6], field[7]].join(" ")
        : record;
    records.push(indexOnly);
  }
  return records.join("\n");
}

/** Путь записи заранее: он же нужен, чтобы заготовить чужую работу рядом и в нём самом. */
function writeRelOf(kind: Kind, name: string, title: string): string {
  if (kind === "card") return `cards/notes/${title.toLowerCase()}.md`;
  return `daily/${name}`;
}

/** Свежий vault прогона: свой репозиторий, база владельца в истории, при нужде - `.gitignore`
 * и падающий pre-commit. */
function makeVaultDir(outcome: Outcome, ignore: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-pbt-vault-"));
  mkdirSync(join(dir, "cards", "notes"), { recursive: true });
  mkdirSync(join(dir, "daily"), { recursive: true });
  cpSync(SCHEMA, join(dir, "schema.json"));
  if (ignore !== null) writeFileSync(join(dir, ".gitignore"), ignore);
  writeFileSync(
    join(dir, "owner-tracked.md"),
    "первая строка\nвторая строка\n",
  );
  git(["init", "-q", "-b", "main"], dir);
  git([...IDENTITY, "add", "-A"], dir);
  git([...IDENTITY, "commit", "-q", "-m", "vault"], dir);
  if (outcome === "hook") {
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
  }
  return dir;
}

/** Чужая работа владельца в vault: рядом с путём записи и в нём самом. */
function foreignWork(vault: string, spec: WriteCase, rel: string): string[] {
  const owner = "owner-tracked.md";
  switch (spec.foreign) {
    case "none":
      return [];
    case "staged-new":
      writeFileSync(join(vault, "owner-new.md"), "чужая новая работа\n");
      git(["add", "--", "owner-new.md"], vault);
      return ["owner-new.md"];
    case "staged-modified":
      writeFileSync(
        join(vault, owner),
        "первая строка\nвторая строка\nтретья\n",
      );
      git(["add", "--", owner], vault);
      return [owner];
    case "staged-deleted":
      rmSync(join(vault, owner));
      git(["add", "--", owner], vault);
      return [owner];
    case "staged-rename":
      git(["mv", owner, "owner-renamed.md"], vault);
      return [owner, "owner-renamed.md"];
    case "partial-hunk":
      writeFileSync(join(vault, owner), "застейджено\nвторая строка\n");
      git(["add", "--", owner], vault);
      writeFileSync(join(vault, owner), "застейджено\nтоже правка\n");
      return [owner];
    case "intent-to-add":
      writeFileSync(join(vault, "owner-ita.md"), "чужая помета\n");
      git(["add", "-N", "--", "owner-ita.md"], vault);
      return ["owner-ita.md"];
    case "untracked":
      writeFileSync(join(vault, "owner-untracked.md"), "чужое нетронутое\n");
      return ["owner-untracked.md"];
    case "modified-tracked":
      writeFileSync(join(vault, owner), "первая строка\nправка без индекса\n");
      return [owner];
    case "sibling-name": {
      // Сосед, на который имя-глоб пути записи замахнётся: `*`, `?`, `[` в имени файла
      // становятся глобом, если git получит его как pathspec, а не как литерал.
      const dir = dirname(rel);
      const literal = spec.name.replace(/[?*[\]]/gu, "x");
      const sibling = `${dir}/${literal}`;
      if (sibling === rel) return [];
      writeFileSync(join(vault, sibling), "чужая заметка под глобом\n");
      return [sibling];
    }
    case "same-path-staged":
      mkdirSync(join(vault, rel, ".."), { recursive: true });
      writeFileSync(join(vault, rel), "чужая версия этого файла\n");
      git(["add", "--", rel], vault);
      rmSync(join(vault, rel));
      return [rel];
  }
}

/** Окружение сценария: переменные смотрят в соседний чужой репозиторий. */
function envPatch(
  spec: WriteCase,
  foreign: string,
  vault: string,
): NodeJS.ProcessEnv {
  switch (spec.env) {
    case "clean":
      return {};
    case "GIT_DIR":
      return { GIT_DIR: join(foreign, ".git") };
    case "GIT_WORK_TREE":
      return { GIT_WORK_TREE: foreign };
    case "GIT_INDEX_FILE":
      return { GIT_INDEX_FILE: join(foreign, ".git", "index") };
    case "GIT_OBJECT_DIRECTORY":
      return { GIT_OBJECT_DIRECTORY: join(foreign, ".git", "objects") };
    case "GIT_COMMON_DIR":
      return { GIT_COMMON_DIR: join(foreign, ".git") };
    case "GIT_NAMESPACE":
      return { GIT_NAMESPACE: "probe" };
    case "GIT_CEILING_DIRECTORIES":
      return { GIT_CEILING_DIRECTORIES: join(vault, "..") };
  }
}

/** Окружение сценария плюс адрес самого vault: без него инструменты писали бы в дефолтный
 * каталог установки, а не в свежий vault прогона. */
function caseEnv(
  spec: WriteCase,
  foreign: string,
  vault: string,
): NodeJS.ProcessEnv {
  return { ASSISTANT_VAULT_DIR: vault, ...envPatch(spec, foreign, vault) };
}

function makeForeignRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-pbt-foreign-"));
  writeFileSync(join(dir, "FOREIGN.md"), "чужой репозиторий\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "foreign@example.com"], dir);
  git(["config", "user.name", "Foreign"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "foreign base"], dir);
  return dir;
}

/** Случаи, которые сценарий не описывает: игнорируемый путь пишется один, а чужая версия того
 * же пути не бывает игнорируемой. */
function valid(spec: WriteCase): boolean {
  if (spec.outcome === "ignored" && spec.kind === "direct") return false;
  return !(spec.foreign === "same-path-staged" && spec.outcome === "ignored");
}

function ignoreFor(spec: WriteCase, rel: string): string | null {
  if (spec.kind === "direct") return `daily/${DIRECT_GONE}\n`;
  if (spec.outcome !== "ignored") return null;
  return spec.kind === "card"
    ? "cards/notes/*\n"
    : `daily/${rel.slice("daily/".length)}\n`;
}

/** Второй путь многопутёвого вызова: его нет в индексе, поэтому `git add` отказывает уже
 * после того, как застейджил первый. */
const DIRECT_GONE = "игнор-pbt.md";

type Tools = {
  card: (
    args: unknown,
  ) => Promise<{ error?: string; file?: string; ok: boolean }>;
  seam: {
    commitVaultWrite: (
      message: string,
      paths: readonly string[],
      root: string,
    ) => Promise<{ committed?: boolean; ok: boolean; reason?: string }>;
  };
  file: (path: string, content: string) => Promise<{ ok: boolean }>;
};

const cardModule = (await import(
  join(REPO, "agent", "tools", "write_card.ts")
)) as unknown as {
  default: {
    execute: (input: unknown) => Promise<{
      error?: string;
      file?: string;
      ok: boolean;
    }>;
    inputSchema: { parse: (value: unknown) => unknown };
  };
};
const fileModule = (await import(
  join(REPO, "agent", "tools", "write_file.ts")
)) as unknown as {
  default: {
    execute: (input: {
      content: string;
      path: string;
    }) => Promise<{ ok: boolean }>;
  };
};
const seam = (await import(
  join(REPO, "agent", "lib", "vault-commit.ts")
)) as unknown as Tools["seam"];

const tool: Tools = {
  card: (args) =>
    cardModule.default.execute(cardModule.default.inputSchema.parse(args)),
  file: (path, content) => fileModule.default.execute({ content, path }),
  seam,
};

async function withEnv<T>(
  patch: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(patch)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withJournal<T>(
  run: () => Promise<T>,
): Promise<{ lines: string[]; value: T }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    return { lines, value: await run() };
  } finally {
    console.error = real;
  }
}

/** Запись памяти: карточка, файл дня или многопутёвый вызов шва. */
async function seedAndWrite(
  spec: WriteCase,
  vault: string,
  rel: string,
  token: string,
): Promise<void> {
  const abs = join(vault, ...rel.split("/"));
  if (spec.kind === "card") {
    const result = await tool.card({
      body: `Факт ${token}.`,
      description: "Описание",
      operation: "ADD",
      tags: ["pbt"],
      title: spec.title,
      type: "note",
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(
      result.file,
      rel,
      "имя карточки то же, что заготовлено сценарием",
    );
    return;
  }
  if (spec.kind === "file") {
    const result = await tool.file(abs, `содержимое ${token}\n`);
    assert.equal(result.ok, true, "правка файла памяти обязана пройти");
    return;
  }
  writeFileSync(abs, `содержимое ${token}\n`);
  await tool.seam.commitVaultWrite(
    `file ${rel}: write`,
    [abs, join(vault, "daily", DIRECT_GONE)],
    vault,
  );
}

/** Пути последнего коммита, как их называет сам git. */
function commitPaths(vault: string): string[] {
  const raw = git(
    [
      "-c",
      "core.quotePath=false",
      "show",
      "--name-only",
      "-z",
      "--pretty=format:",
      "HEAD",
    ],
    vault,
  );
  return raw.split("\0").filter(Boolean).sort();
}

const foreignDir = makeForeignRepo();
/** Отпечаток до всего прогона: соседний репозиторий обязан пережить все двести случаев. */
const foreignAtStart = fingerprint(foreignDir);

void test("инвариант шва коммита памяти держится на произвольном случае", async () => {
  console.log(`      seed ${String(SEED)}, прогонов ${String(RUNS)}`);
  let token = 0;
  try {
    await fc.assert(
      fc.asyncProperty(writeCaseArb, async (spec) => {
        fc.pre(valid(spec));
        token += 1;
        const rel = writeRelOf(spec.kind, spec.name, spec.title);
        const vault = makeVaultDir(spec.outcome, ignoreFor(spec, rel));
        try {
          // Отпечаток берётся на каждый случай: иначе провал одного случая портит проверку
          // всем следующим, и контрпример от fast-check перестаёт быть про свой случай.
          const foreignBefore = fingerprint(foreignDir);
          const foreignPaths = foreignWork(vault, spec, rel);
          const others = foreignPaths.filter((path) => path !== rel);
          const before = {
            index: indexOf(vault, [rel]),
            others: stateOf(vault, others),
          };
          const { lines, value } = await withEnv(
            caseEnv(spec, foreignDir, vault),
            () =>
              withJournal(() => seedAndWrite(spec, vault, rel, String(token))),
          );
          assert.equal(
            existsSync(join(vault, ...rel.split("/"))),
            true,
            "запись на диск обязана состояться",
          );
          const after = {
            index: indexOf(vault, [rel]),
            others: stateOf(vault, others),
          };
          // База прогона - ровно один коммит, поэтому счётчик отвечает и на «есть коммит», и
          // на «ровно один»: 1 - коммита нет, 2 - один новый.
          const delta = Number(git(["rev-list", "--count", "HEAD"], vault)) - 1;
          assert.ok(
            delta === 0 || delta === 1,
            `новых коммитов ${String(delta)}`,
          );
          if (delta === 1) {
            assert.deepEqual(
              commitPaths(vault),
              [rel],
              "коммит называет ровно пути записи",
            );
          } else {
            assert.equal(
              lines.filter((line) => line.startsWith("[vault-commit]")).length,
              1,
              `коммита нет - причина обязана быть в журнале: ${JSON.stringify(value)}`,
            );
            assert.equal(
              after.index,
              before.index,
              "записи индекса по путям записи вернулись как были",
            );
          }
          assert.equal(after.others, before.others, "чужая работа не тронута");
          assert.equal(
            fingerprint(foreignDir),
            foreignBefore,
            "чужой репозиторий не тронут",
          );
        } finally {
          rmSync(vault, {
            force: true,
            maxRetries: 3,
            recursive: true,
            retryDelay: 50,
          });
        }
      }),
      { numRuns: RUNS, seed: SEED },
    );
    assert.equal(
      fingerprint(foreignDir),
      foreignAtStart,
      "чужой репозиторий пережил весь прогон",
    );
  } finally {
    rmSync(foreignDir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    });
  }
});
