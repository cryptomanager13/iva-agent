/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Тесты контрактов файловых тулов: write_file не затирает существующие карточки,
// путь из memory_search открывается read_file, glob и grep обходят vault-симлинк.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";

const VAULT = mkdtempSync(join(tmpdir(), "iva-paths-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
mkdirSync(join(VAULT, "cards", "contacts"), { recursive: true });
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const CARD = join(VAULT, "cards", "contacts", "ivan.md");
writeFileSync(
  CARD,
  `---\ntype: contact\ndescription: Иван Петров, подрядчик по монтажу\ntags: [contact]\nstatus: active\n---\n\n# Иван Петров\n\nПодрядчик по видеомонтажу, работает через студию Кинолаб.\n`,
  "utf8",
);
writeFileSync(join(VAULT, "CORE.md"), "# CORE\n", "utf8");

const { default: writeFile } = await import("../agent/tools/write_file.ts");
const { default: readFileTool } = await import("../agent/tools/read_file.ts");
const { default: globTool } = await import("../agent/tools/glob.ts");
const { default: grepTool } = await import("../agent/tools/grep.ts");
const { resolveVaultToolPath, walkFiles } =
  await import("../agent/lib/vault-file-search.ts");
const { default: memorySearch } =
  await import("../agent/tools/memory_search.ts");

function testToolContext(toolName: string): ToolContext {
  const unavailable = (): never => {
    throw new Error("not used by this test");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "vault-tools-paths",
    toolName,
    session: {
      id: "vault-tools-paths",
      auth: { current: null, initiator: null },
      turn: { id: "vault-tools-paths", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("not used by this test")),
    getSkill: unavailable,
    getToken: () => Promise.reject(new Error("not used by this test")),
    requireAuth: unavailable,
  };
}

test("write_file отказывается перезаписать существующую карточку в cards/", async () => {
  const res = settled(
    await writeFile.execute(
      { path: CARD, content: "затёрто" },
      testToolContext("write_file"),
    ),
  );
  assert.equal(res.ok, false);
  if (typeof res.error !== "string") assert.fail("expected write_file error");
  assert.match(res.error, /write_card/);
  assert.ok(
    readFileSync(CARD, "utf8").includes("Кинолаб"),
    "карточка всё-таки затёрта",
  );
});

test("write_file создаёт НОВЫЙ файл в cards/ как обычно", async () => {
  const fresh = join(VAULT, "cards", "contacts", "новый.md");
  const res = settled(
    await writeFile.execute(
      { path: fresh, content: "# Новый\n" },
      testToolContext("write_file"),
    ),
  );
  assert.equal(res.ok, true);
  assert.equal(readFileSync(fresh, "utf8"), "# Новый\n");
});

test("write_file по-прежнему пишет vault/CORE.md (см. instructions/10-map.md)", async () => {
  const core = join(VAULT, "CORE.md");
  const res = settled(
    await writeFile.execute(
      {
        path: core,
        content: "# CORE\n- факт\n",
      },
      testToolContext("write_file"),
    ),
  );
  assert.equal(res.ok, true);
  assert.ok(readFileSync(core, "utf8").includes("факт"));
});

test("путь из memory_search открывается read_file без ENOENT", async () => {
  const found = settled(
    await memorySearch.execute(
      {
        query: "Иван Петров монтаж",
        limit: 5,
      },
      testToolContext("memory_search"),
    ),
  );
  assert.ok(found.hits.length > 0, "memory_search ничего не нашёл");
  const hit = found.hits[0].file;
  // Контракт: hits[].file — vault-relative, read_file обязан его понять.
  assert.ok(
    !hit.startsWith("/"),
    `ожидался vault-относительный путь, получено ${hit}`,
  );
  const read = settled(
    await readFileTool.execute({ path: hit }, testToolContext("read_file")),
  );
  assert.ok(read.content.includes("Кинолаб"));
});

test("read_file принимает и абсолютный путь", async () => {
  const read = settled(
    await readFileTool.execute({ path: CARD }, testToolContext("read_file")),
  );
  assert.ok(read.content.includes("Иван Петров"));
});

const SYMLINK_LAYOUT = mkdtempSync(join(tmpdir(), "iva-symlink-paths-"));
const APP_ROOT = join(SYMLINK_LAYOUT, "app");
const REAL_VAULT = join(SYMLINK_LAYOUT, "real-vault");
const PROJECT = join(REAL_VAULT, "projects", "x");
const OUTSIDE = join(SYMLINK_LAYOUT, "outside");
mkdirSync(APP_ROOT, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(PROJECT, "needle.md"), "строка T57 найдена\n", "utf8");
writeFileSync(join(OUTSIDE, "external.txt"), "вне vault\n", "utf8");
symlinkSync(REAL_VAULT, join(APP_ROOT, "vault"), "dir");
symlinkSync(join(PROJECT, "needle.md"), join(PROJECT, "alias.md"), "file");
symlinkSync(REAL_VAULT, join(PROJECT, "loop"), "dir");
process.on("exit", () =>
  rmSync(SYMLINK_LAYOUT, { recursive: true, force: true }),
);

async function fromSymlinkedVault<T>(run: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const previousVault = process.env.ASSISTANT_VAULT_DIR;
  delete process.env.ASSISTANT_VAULT_DIR;
  process.chdir(APP_ROOT);
  try {
    return await run();
  } finally {
    process.chdir(previousCwd);
    if (previousVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previousVault;
  }
}

test("glob видит vault-симлинк от каталога приложения и по умолчанию", async () => {
  const fromApp = settled(
    await globTool.execute(
      { pattern: "vault/projects/x/**", cwd: APP_ROOT },
      testToolContext("glob"),
    ),
  );
  assert.ok(
    fromApp.includes("vault/projects/x/needle.md"),
    `glob не нашёл vault/projects/x/needle.md от каталога приложения: ${JSON.stringify(fromApp)}`,
  );

  const fromVault = await fromSymlinkedVault(async () =>
    settled(
      await globTool.execute(
        { pattern: "projects/x/**" },
        testToolContext("glob"),
      ),
    ),
  );
  assert.ok(
    fromVault.includes("projects/x/needle.md"),
    `glob не нашёл projects/x/needle.md от корня vault: ${JSON.stringify(fromVault)}`,
  );
  assert.ok(
    fromVault.includes("projects/x/alias.md"),
    `glob не счёл симлинк на файл файлом: ${JSON.stringify(fromVault)}`,
  );

  const fromRelativeCwd = await fromSymlinkedVault(async () =>
    settled(
      await globTool.execute(
        { pattern: "x/**", cwd: "projects" },
        testToolContext("glob"),
      ),
    ),
  );
  assert.ok(
    fromRelativeCwd.includes("x/needle.md"),
    `glob не резолвит относительный cwd от vault: ${JSON.stringify(fromRelativeCwd)}`,
  );
});

test("grep резолвит относительный path от vault-симлинка", async () => {
  const result = await fromSymlinkedVault(async () =>
    settled(
      await grepTool.execute(
        { pattern: "T57", path: "projects/x" },
        testToolContext("grep"),
      ),
    ),
  );
  assert.equal(
    result.count,
    2,
    `grep нашёл не оба файла: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(
    result.matches.map((match) => basename(match.file)).sort(),
    ["alias.md", "needle.md"],
    `grep не нашёл оба пути через vault-симлинк: ${JSON.stringify(result.matches)}`,
  );
});

// #242: ночной memory-daily подал grep путь от корня проекта (`vault/daily/…`), тул
// приклеил его к корню vault и упал на vault/vault/… с ENOENT.
test("read_file, grep и glob принимают путь с префиксом vault/ от корня проекта", async () => {
  const [read, grep, glob] = await fromSymlinkedVault(async () => [
    settled(
      await readFileTool.execute(
        { path: "vault/projects/x/needle.md" },
        testToolContext("read_file"),
      ),
    ),
    settled(
      await grepTool.execute(
        { pattern: "T57", path: "vault/projects/x/needle.md" },
        testToolContext("grep"),
      ),
    ),
    settled(
      await globTool.execute(
        { pattern: "*.md", cwd: "vault/projects/x" },
        testToolContext("glob"),
      ),
    ),
  ]);
  assert.match(String(read.content), /T57/);
  assert.equal(grep.count, 1, `grep: ${JSON.stringify(grep)}`);
  assert.deepEqual(glob, ["alias.md", "needle.md"]);
});

test("read_file не читает одноимённый файл проекта вне vault", async () => {
  const projectOnly = join(APP_ROOT, "project-only.txt");
  writeFileSync(projectOnly, "только в проекте\n", "utf8");
  try {
    await assert.rejects(
      fromSymlinkedVault(async () =>
        settled(
          await readFileTool.execute(
            { path: "project-only.txt" },
            testToolContext("read_file"),
          ),
        ),
      ),
      { code: "ENOENT" },
    );
  } finally {
    rmSync(projectOnly, { force: true });
  }
});

test("настоящий vault/vault/ внутри vault по-прежнему первичен", async () => {
  const nested = join(REAL_VAULT, "vault");
  const topFile = join(REAL_VAULT, "inner.md");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "inner.md"), "вложенный T99\n", "utf8");
  writeFileSync(topFile, "верхний T99\n", "utf8");
  try {
    const [read, grep] = await fromSymlinkedVault(async () => [
      settled(
        await readFileTool.execute(
          { path: "vault/inner.md" },
          testToolContext("read_file"),
        ),
      ),
      settled(
        await grepTool.execute(
          { pattern: "T99", path: "vault" },
          testToolContext("grep"),
        ),
      ),
    ]);
    assert.equal(read.content, "вложенный T99\n");
    assert.equal(grep.count, 1, `grep: ${JSON.stringify(grep)}`);
    assert.equal(basename(grep.matches[0].file), "inner.md");
  } finally {
    rmSync(topFile, { force: true });
    rmSync(nested, { recursive: true, force: true });
  }
});

const RESOLVER_SEED = 20260923;

test(`резолвер выбирает только путь внутри vault (fast-check seed ${RESOLVER_SEED})`, () => {
  fc.assert(
    fc.property(
      fc.record({
        prefix: fc.boolean(),
        name: fc
          .array(fc.constantFrom("a", "b", "c", "0", "1"), {
            minLength: 1,
            maxLength: 5,
          })
          .map((parts) => `${parts.join("")}.txt`),
        vaultFile: fc.boolean(),
        cwdFile: fc.boolean(),
      }),
      ({ prefix, name, vaultFile, cwdFile }) => {
        const root = mkdtempSync(join(tmpdir(), "iva-resolver-property-"));
        const vault = join(root, "vault");
        const input = prefix ? `vault/${name}` : name;
        const fromVault = resolve(vault, input);
        const fromCwd = resolve(root, input);
        const previousCwd = process.cwd();
        const previousVault = process.env.ASSISTANT_VAULT_DIR;
        try {
          mkdirSync(vault, { recursive: true });
          if (vaultFile) {
            mkdirSync(resolve(fromVault, ".."), { recursive: true });
            writeFileSync(fromVault, "vault\n");
          }
          if (cwdFile) writeFileSync(fromCwd, "cwd\n");
          process.env.ASSISTANT_VAULT_DIR = vault;
          process.chdir(root);

          const actual = resolveVaultToolPath(input);
          const inside = relative(vault, actual);
          assert.ok(
            inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)),
            `путь вне vault: ${actual}`,
          );
          assert.ok(
            actual === fromVault ||
              (actual === fromCwd &&
                !existsSync(fromVault) &&
                existsSync(fromCwd)),
            `неверный приоритет для ${input}: ${actual}`,
          );
        } finally {
          process.chdir(previousCwd);
          if (previousVault === undefined)
            delete process.env.ASSISTANT_VAULT_DIR;
          else process.env.ASSISTANT_VAULT_DIR = previousVault;
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
    { seed: RESOLVER_SEED, numRuns: 300 },
  );
});

test(
  "цикл симлинков не зацикливает glob и grep",
  { timeout: 2_000 },
  async () => {
    const walked = await walkFiles(join(APP_ROOT, "vault"));
    assert.deepEqual(
      walked.map((file) => basename(file)).sort(),
      ["alias.md", "needle.md"],
      `общий обход повторно прошёл цикл: ${JSON.stringify(walked)}`,
    );

    const globResult = await fromSymlinkedVault(async () =>
      settled(
        await globTool.execute(
          { pattern: "projects/x/**" },
          testToolContext("glob"),
        ),
      ),
    );
    assert.deepEqual(
      globResult,
      ["projects/x/alias.md", "projects/x/needle.md"],
      `glob повторно обошёл цикл: ${JSON.stringify(globResult)}`,
    );

    const grepResult = await fromSymlinkedVault(async () =>
      settled(
        await grepTool.execute(
          { pattern: "T57", path: "projects" },
          testToolContext("grep"),
        ),
      ),
    );
    assert.equal(
      grepResult.count,
      2,
      `grep повторно обошёл цикл: ${JSON.stringify(grepResult)}`,
    );
  },
);

test("glob и grep сохраняют абсолютный путь вне vault", async () => {
  const globResult = settled(
    await globTool.execute(
      { pattern: "**/*.txt", cwd: OUTSIDE },
      testToolContext("glob"),
    ),
  );
  assert.deepEqual(
    globResult,
    ["external.txt"],
    `glob не нашёл абсолютный cwd вне vault: ${JSON.stringify(globResult)}`,
  );

  const grepResult = settled(
    await grepTool.execute(
      { pattern: "вне vault", path: join(OUTSIDE, "external.txt") },
      testToolContext("grep"),
    ),
  );
  assert.equal(
    grepResult.count,
    1,
    `grep не прочитал абсолютный path вне vault: ${JSON.stringify(grepResult)}`,
  );
});

// Инструкции не должны давать read_file, grep и glob путь с префиксом `vault/`: тулы
// резолвят относительный путь ОТ корня vault, и `vault/daily/x.md` превращается в
// vault/vault/daily/x.md (#199, #242). Шелл-команда живёт в одном спане с путём
// (`ls vault/…`, блок ```bash) и сюда не попадает; отдельный спан `vault/…` рядом со
// словом grep — это путь для тула. Исключение одно: write_file берёт путь от корня проекта.
// Скиллы (agent/skills) сюда не входят намеренно: они гоняют шелл-утилиты и получают от
// Telegram ХОСТОВЫЙ путь вложения (`vault/attachments/…`, см. lib/telegram-media.ts) —
// там префикс правильный. Контракт read_file живёт в инструкциях и ночных промптах.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INSTRUCTION_ROOTS = ["agent/instructions", "scripts/memory/instructions"];
const VAULT_PREFIXED =
  /`vault\/(CORE\.md|MOC\.md|PERSONA\.md|schema\.json|cards|daily|summaries|weekly|monthly|yearly)/;
const HOST_RELATIVE = /`write_file`/;

test("инструкции не префиксуют vault/ пути, которые уходят в тулы чтения", () => {
  const offenders: string[] = [];
  for (const root of INSTRUCTION_ROOTS) {
    const names = readdirSync(join(ROOT, root), {
      recursive: true,
      encoding: "utf8",
    });
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const lines = readFileSync(join(ROOT, root, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!VAULT_PREFIXED.test(line)) return;
        if (HOST_RELATIVE.test(line)) return;
        offenders.push(`${root}/${name}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `read_file, grep и glob резолвят путь от корня vault — префикс vault/ даёт ENOENT:\n${offenders.join("\n")}`,
  );
});

// T24 v3: неверная настройка вольта — отказ ok:false с текстом резолвера, не исключение.
test("тулы возвращают ok:false на пустом ASSISTANT_VAULT_DIR", async () => {
  const previous = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = "";
  try {
    const read = settled(
      await readFileTool.execute(
        { path: "CORE.md" },
        testToolContext("read_file"),
      ),
    ) as { ok?: boolean; error?: string };
    assert.equal(read.ok, false);
    assert.match(String(read.error), /ASSISTANT_VAULT_DIR/);

    // Существующий файл: только его карточный гард зовёт резолвер (новый путь — нет).
    const write = settled(
      await writeFile.execute(
        { path: CARD, content: "x" },
        testToolContext("write_file"),
      ),
    ) as { ok?: boolean; error?: string };
    assert.equal(write.ok, false);
    assert.match(String(write.error), /ASSISTANT_VAULT_DIR/);

    const search = settled(
      await memorySearch.execute(
        { query: "Иван" },
        testToolContext("memory_search"),
      ),
    ) as { ok?: boolean; error?: string };
    assert.equal(search.ok, false);
    assert.match(String(search.error), /ASSISTANT_VAULT_DIR/);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previous;
  }
});
