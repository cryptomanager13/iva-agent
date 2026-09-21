/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Память под git: одна успешная правка = один локальный коммит затронутых путей vault.
// Проверяем поведение через публичный шов: инструменты (write_card, write_file) и сам
// commitVaultWrite; состояние читаем из настоящего репозитория git.
// Запуск: node --test scripts/vault-commit.test.ts

import "./lib/ts-esm-hooks.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = join(REPO, "vault-template", "schema.json");
process.env.ASSISTANT_TIMEZONE = "UTC";

/** Свежий vault на каждый тест: репозиторий git заводится, только если тест про него. */
function makeVault(
  t: { after(fn: () => void): void },
  {
    repo = true,
    identity = "Test",
  }: { repo?: boolean; identity?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-vault-"));
  // Большой vault с тысячами файлов сносится не с первой попытки.
  t.after(() =>
    rmSync(dir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    }),
  );
  mkdirSync(join(dir, "cards", "contacts"), { recursive: true });
  mkdirSync(join(dir, "cards", "notes"), { recursive: true });
  cpSync(SCHEMA, join(dir, "schema.json"));
  if (repo) {
    sh(["init", "-q", "-b", "main"], dir);
    if (identity) sh(["config", "user.email", `${identity}@example.com`], dir);
    if (identity) sh(["config", "user.name", identity], dir);
    // Как init-vault: стартовое состояние vault уже в истории, иначе первый же
    // тест читал бы чужую незакоммиченную правку.
    sh(["add", "-A"], dir);
    sh(["commit", "-q", "-m", "vault"], dir);
  }
  process.env.ASSISTANT_VAULT_DIR = dir;
  return dir;
}

function sh(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

/** Тем же способом, что и шов: git обязан уметь работать в этом каталоге. */
function trySh(args: readonly string[], cwd: string): string {
  try {
    return sh(args, cwd);
  } catch {
    return "";
  }
}

/** История правок памяти: стартовый коммит vault в неё не входит. */
const subjects = (vault: string) =>
  trySh(["log", "--pretty=%s"], vault)
    .split("\n")
    .filter((subject) => subject && subject !== "vault");

const touched = (vault: string) =>
  trySh(
    ["-c", "core.quotePath=false", "show", "--name-only", "--pretty=", "HEAD"],
    vault,
  )
    .split("\n")
    .filter(Boolean);

const porcelain = (vault: string) =>
  trySh(["-c", "core.quotePath=false", "status", "--porcelain"], vault);

const day = () =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date());

type WriteCardResult = {
  action: string;
  error: string;
  file: string;
  ok: boolean;
};
type WriteFileResult = {
  bytes: number;
  error: string;
  ok: boolean;
  path: string;
};

/** Импорт инструментов после того, как каталог vault уже выставлен. Динамический импорт:
 * статический слинковался бы до регистрации resolve-хука (.js→.ts). */
const loadTools = async () => {
  const card = (await import(
    join(REPO, "agent", "tools", "write_card.ts")
  )) as typeof import("../agent/tools/write_card.ts");
  const file = (await import(
    join(REPO, "agent", "tools", "write_file.ts")
  )) as typeof import("../agent/tools/write_file.ts");
  const seam = (await import(
    join(REPO, "agent", "lib", "vault-commit.ts")
  )) as typeof import("../agent/lib/vault-commit.ts");
  const cardTool = card.default as unknown as {
    execute: (input: unknown) => Promise<WriteCardResult>;
    inputSchema: { parse: (value: unknown) => unknown };
  };
  const fileTool = file.default as unknown as {
    execute: (input: unknown) => Promise<WriteFileResult>;
  };
  return {
    card: (args: unknown) => cardTool.execute(cardTool.inputSchema.parse(args)),
    file: (path: string, content: string) =>
      fileTool.execute({ content, path }),
    seam,
  };
};

const tool = await loadTools();

const card = (overrides: Record<string, unknown>) => ({
  body: "Факт из разговора.",
  description: "Описание карточки",
  tags: ["test"],
  title: "Проверочная карточка",
  type: "note",
  ...overrides,
});

/** Причина отказа одной строкой уходит в журнал: строки журнала возвращаются рядом со
 * значением перехваченного вызова. */
async function journal<T>(
  run: () => Promise<T>,
): Promise<{ logged: string; value: T }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  let value: T;
  try {
    value = await run();
  } finally {
    console.error = real;
  }
  return { logged: lines.join("\n"), value };
}

test("ADD, UPDATE и SUPERSEDE оставляют по коммиту с карточкой и операцией", async (t) => {
  const vault = makeVault(t);
  const added = await tool.card(
    card({
      body: "работает в TDI Group.",
      description: "работает в TDI Group",
      operation: "ADD",
      title: "Батыр",
    }),
  );
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(subjects(vault), ["card батыр: ADD"]);
  assert.deepEqual(touched(vault), ["cards/notes/батыр.md"]);
  assert.equal(porcelain(vault), "");

  const updated = await tool.card(
    card({
      description: "работает в TDI Group",
      operation: "UPDATE",
      title: "Батыр",
      body: "Позвонил по смете.",
    }),
  );
  assert.equal(updated.ok, true, updated.error);
  assert.deepEqual(subjects(vault), ["card батыр: UPDATE", "card батыр: ADD"]);
  assert.deepEqual(touched(vault), ["cards/notes/батыр.md"]);

  const replaced = await tool.card(
    card({
      body: "Ушёл из TDI Group.",
      description: "Работает в Majento",
      history_entry: `${day()}: работает в TDI Group`,
      operation: "SUPERSEDE",
      title: "Батыр",
    }),
  );
  assert.equal(replaced.ok, true, replaced.error);
  assert.deepEqual(subjects(vault), [
    "card батыр: SUPERSEDE",
    "card батыр: UPDATE",
    "card батыр: ADD",
  ]);
  assert.equal(porcelain(vault), "");

  // Чтение карточки коммитов не делает: коммит - это правка, а не обращение.
  const noop = await tool.card(
    card({
      operation: "NOOP",
      title: "Батыр",
      description: "Работает в Majento",
    }),
  );
  assert.equal(noop.ok, true, noop.error);
  assert.equal(subjects(vault).length, 3);
});

test("write_file коммитит только то, что лежит внутри vault", async (t) => {
  const vault = makeVault(t);
  const inside = join(vault, "daily", "2026-09-21.md");
  const written = await tool.file(inside, "Дневная запись\n");
  assert.equal(written.ok, true, written.error);
  assert.deepEqual(subjects(vault), ["file daily/2026-09-21.md: write"]);
  assert.deepEqual(touched(vault), ["daily/2026-09-21.md"]);

  const outside = join(vault, "..", `outside-${String(process.pid)}.md`);
  t.after(() => rmSync(outside, { force: true }));
  const other = await tool.file(outside, "Не память\n");
  assert.equal(other.ok, true, other.error);
  assert.equal(
    subjects(vault).length,
    1,
    "правка вне vault коммитов не делает",
  );
  assert.equal(porcelain(vault), "");
});

test("чужая незакоммиченная правка переживает коммит и в него не попадает", async (t) => {
  const vault = makeVault(t);
  await tool.card(card({ operation: "ADD", title: "Первая" }));

  const foreign = join(vault, "cards", "notes", "чужая.md");
  writeFileSync(foreign, "# Чужая правка владельца\n");
  const result = await tool.card(
    card({ operation: "ADD", title: "Вторая", body: "Вторая карточка." }),
  );
  assert.equal(result.ok, true, result.error);

  assert.equal(readFileSync(foreign, "utf8"), "# Чужая правка владельца\n");
  assert.deepEqual(touched(vault), ["cards/notes/вторая.md"]);
  assert.match(porcelain(vault), /^\?\? cards\/notes\/чужая\.md$/mu);
  assert.deepEqual(subjects(vault), ["card вторая: ADD", "card первая: ADD"]);
});

test("двадцать параллельных правок разных карточек дают двадцать коммитов", async (t) => {
  const vault = makeVault(t);
  const titles = Array.from({ length: 20 }, (_, index) => `Карточка-${index}`);
  const results = await Promise.all(
    titles.map((title, index) =>
      tool.card(
        card({ body: `Факт ${index}.`, operation: "ADD", title: title }),
      ),
    ),
  );
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.error),
    [],
  );
  assert.equal(subjects(vault).length, 20);
  for (const title of titles) {
    const file = join(vault, "cards", "notes", `${title.toLowerCase()}.md`);
    assert.match(readFileSync(file, "utf8"), /^# /mu);
  }
  assert.equal(porcelain(vault), "");
  assert.equal(trySh(["fsck", "--no-progress"], vault).length >= 0, true);
});

test("пять параллельных правок одной карточки не теряют ни одну", async (t) => {
  const vault = makeVault(t);
  await tool.card(card({ operation: "ADD", title: "Одна" }));
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      tool.card(
        card({
          body: `Уточнение ${index}.`,
          description: `Описание ${index}`,
          operation: "UPDATE",
          title: "Одна",
        }),
      ),
    ),
  );
  const ok = results.filter((result) => result.ok).length;
  assert.equal(ok, 5, JSON.stringify(results.map((result) => result.error)));
  assert.equal(subjects(vault).length, 6);
  assert.equal(porcelain(vault), "");
  const text = readFileSync(join(vault, "cards", "notes", "одна.md"), "utf8");
  assert.match(text, /^## Log$/mu);
  assert.equal(text.match(/Уточнение \d\./gu)?.length, 5);
});

test("vault не репозиторий: правка записывается, причина отказа в журнале", async (t) => {
  const vault = makeVault(t, { repo: false });
  const { logged, value: result } = await journal(() =>
    tool.card(card({ operation: "ADD", title: "Без-гита" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(
    readFileSync(join(vault, "cards", "notes", "без-гита.md"), "utf8"),
    /^# /mu,
  );
  assert.match(logged, /^\[vault-commit\] card без-гита: ADD: /u);
  assert.equal(logged.split("\n").length, 1, "причина отказа - одна строка");
});

test("git не в PATH: правка записывается, ход не падает", async (t) => {
  const vault = makeVault(t);
  const path = process.env.PATH;
  const { logged, value: result } = await journal(async () => {
    process.env.PATH = "";
    try {
      return await tool.card(card({ operation: "ADD", title: "Без-PATH" }));
    } finally {
      process.env.PATH = path;
    }
  });
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /git не найден в PATH/u);
  assert.equal(existsSync(join(vault, "cards", "notes", "без-path.md")), true);
  assert.deepEqual(subjects(vault), []);
});

test("в vault нет identity: коммит всё равно есть, конфиг владельца не тронут", async (t) => {
  const vault = makeVault(t, { identity: "" });
  const previous = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_SYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  sh(["config", "user.useConfigOnly", "true"], vault);
  t.after(() => {
    process.env.GIT_CONFIG_GLOBAL = previous.global;
    process.env.GIT_CONFIG_SYSTEM = previous.system;
  });

  const result = await tool.card(
    card({ operation: "ADD", title: "Без имени" }),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(subjects(vault), ["card без-имени: ADD"]);
  assert.equal(
    sh(["log", "-1", "--pretty=%an <%ae>"], vault),
    "Iva <iva@localhost>",
  );
  assert.equal(
    trySh(["config", "--get", "user.email"], vault),
    "",
    "чужой конфиг не тронут",
  );
});

test("замок индекса от убитого коммита снимается, следующий коммит работает", async (t) => {
  const vault = makeVault(t);
  await tool.card(card({ operation: "ADD", title: "До-замка" }));
  const lock = join(vault, ".git", "index.lock");
  writeFileSync(lock, "");
  const past = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(lock, past, past);

  const result = await tool.card(
    card({ operation: "ADD", title: "После-замка" }),
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(
    existsSync(lock),
    false,
    "огрызок убитого коммита не остаётся навсегда",
  );
  assert.deepEqual(subjects(vault), [
    "card после-замка: ADD",
    "card до-замка: ADD",
  ]);
});

test("свежий замок индекса: правка сохранена, причина в журнале, следующий коммит проходит", async (t) => {
  const vault = makeVault(t);
  const lock = join(vault, ".git", "index.lock");
  writeFileSync(lock, "");
  const { logged, value: result } = await journal(() =>
    tool.card(card({ operation: "ADD", title: "Занят" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /lock file may be stale|index\.lock/u);
  assert.deepEqual(subjects(vault), []);
  assert.equal(
    readFileSync(join(vault, "cards", "notes", "занят.md"), "utf8").length > 0,
    true,
  );

  rmSync(lock);
  const later = await tool.card(card({ operation: "ADD", title: "Свободен" }));
  assert.equal(later.ok, true, later.error);
  assert.deepEqual(subjects(vault), ["card свободен: ADD"]);
});

test("SIGKILL посреди коммита не ломает ни vault, ни следующие коммиты", async (t) => {
  const vault = makeVault(t);
  const script = join(vault, "..", `killed-${String(process.pid)}.mts`);
  t.after(() => rmSync(script, { force: true }));
  writeFileSync(
    script,
    `const seam = await import(${JSON.stringify(join(REPO, "agent", "lib", "vault-commit.ts"))});
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const vault = process.env.ASSISTANT_VAULT_DIR;
for (let index = 0; index < 40; index += 1) {
  const file = join(vault, "cards", "notes", \`loop-\${index}.md\`);
  writeFileSync(file, \`# loop \${index}\\n\`);
  process.stdout.write("written\\n");
  await seam.commitVaultWrite(\`card loop-\${index}: ADD\`, [file]);
}
`,
  );
  const child = spawn(
    process.execPath,
    ["--import", join(REPO, "scripts", "lib", "ts-esm-hooks.ts"), script],
    { cwd: REPO, env: { ...process.env, ASSISTANT_VAULT_DIR: vault } },
  );
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");

  // Ровно то, что делает ночной подметальщик: свой add -A и свой коммит.
  const lock = join(vault, ".git", "index.lock");
  if (existsSync(lock))
    utimesSync(lock, new Date(Date.now() - 5 * 60 * 1000), new Date());
  const swept = await tool.seam.commitVaultWrite(
    `chore: memory ${day()}`,
    trySh(["status", "--porcelain", "-z"], vault)
      .split("\0")
      .filter(Boolean)
      .map((entry) => join(vault, entry.slice(3))),
    vault,
  );
  assert.equal(swept.ok, true);
  assert.equal(existsSync(lock), false);
  assert.ok(subjects(vault).length >= 1, "после убийства коммит проходит");
  assert.equal(trySh(["fsck", "--no-progress"], vault).length >= 0, true);

  const after = await tool.card(
    card({ operation: "ADD", title: "После-смерти" }),
  );
  assert.equal(after.ok, true, after.error);
  assert.equal(subjects(vault)[0], "card после-смерти: ADD");
  assert.equal(porcelain(vault), "");
});

test("коммит правки в vault из двух тысяч карточек стоит десятки миллисекунд", async (t) => {
  // Замер в одном и том же vault и в один и тот же момент: сначала без репозитория
  // (коммит пропускается), потом с ним. Разница и есть цена коммита, а не цена машины.
  const vault = makeVault(t, { repo: false });
  for (let index = 0; index < 2000; index += 1) {
    writeFileSync(
      join(vault, "cards", "notes", `bulk-${index}.md`),
      `---\ntype: "note"\ndescription: "Карточка ${index}"\n---\n\n# Карточка ${index}\n\nТекст.\n`,
    );
  }
  const medianWrite = async (prefix: string): Promise<number> => {
    const times: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const started = Date.now();
      const result = await tool.card(
        card({ operation: "ADD", title: `${prefix}-${index}` }),
      );
      assert.equal(result.ok, true, result.error);
      times.push(Date.now() - started);
    }
    return [...times].sort((one, other) => one - other)[2];
  };
  const { value: plain } = await journal(() => medianWrite("Без-гита"));
  sh(["init", "-q", "-b", "main"], vault);
  sh(["config", "user.email", "vault@example.com"], vault);
  sh(["config", "user.name", "Vault"], vault);
  sh(["add", "-A"], vault);
  sh(["commit", "-q", "-m", "bulk"], vault);
  const committed = await medianWrite("С-гитом");
  const delta = committed - plain;
  console.log(
    `      vault из 2000 карточек: правка ${String(plain)} мс, с коммитом ${String(committed)} мс, цена коммита ${String(delta)} мс`,
  );
  assert.ok(subjects(vault).includes("card с-гитом-0: ADD"));
  assert.ok(
    committed < 1000,
    `правка с коммитом заняла ${String(committed)} мс`,
  );
  assert.ok(delta < 300, `коммит правки занял ${String(delta)} мс`);
});

/** Чужой процесс в репозитории vault: правки владельца, упавший hook, висящий hook. */
function hook(vault: string, body: string): void {
  const path = join(vault, ".git", "hooks", "pre-commit");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test("чужой staged-файл остаётся staged и в коммит записи не уезжает", async (t) => {
  const vault = makeVault(t);
  const foreign = join(vault, "owner-staged.md");
  writeFileSync(foreign, "Чужая работа владельца\n");
  sh(["add", "--", "owner-staged.md"], vault);

  const result = await tool.card(
    card({ body: "Вторая карточка.", operation: "ADD", title: "Вторая" }),
  );
  assert.equal(result.ok, true, result.error);

  assert.deepEqual(touched(vault), ["cards/notes/вторая.md"]);
  assert.deepEqual(subjects(vault), ["card вторая: ADD"]);
  assert.match(
    porcelain(vault),
    /^A {2}owner-staged\.md$/mu,
    "работа владельца остаётся в индексе, а не в истории памяти",
  );
  assert.equal(readFileSync(foreign, "utf8"), "Чужая работа владельца\n");
});
test("осиротевшая запись убитого хода не уезжает в следующий коммит", async (t) => {
  const vault = makeVault(t);
  // Так выглядит индекс после SIGKILL посреди коммита: карточка написана и добавлена,
  // коммита нет. Следующая запись обязана назвать только свои пути.
  writeFileSync(
    join(vault, "cards", "notes", "сирота.md"),
    '---\ntype: "note"\ndescription: "Сирота"\n---\n\n# Сирота\n\nТекст.\n',
  );
  sh(["add", "--", "cards/notes/сирота.md"], vault);

  const result = await tool.card(
    card({ body: "Следующая карточка.", operation: "ADD", title: "Следующая" }),
  );
  assert.equal(result.ok, true, result.error);

  assert.deepEqual(touched(vault), ["cards/notes/следующая.md"]);
  assert.match(porcelain(vault), /^A {2}cards\/notes\/сирота\.md$/mu);
});
test("упавший pre-commit: запись на диске, коммита нет, карточка не остаётся staged", async (t) => {
  const vault = makeVault(t);
  hook(vault, "echo 'hook says no' >&2\nexit 1");

  const { logged, value: result } = await journal(() =>
    tool.card(card({ operation: "ADD", title: "Падхук" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /hook says no/u);
  assert.equal(existsSync(join(vault, "cards", "notes", "падхук.md")), true);
  assert.deepEqual(subjects(vault), []);
  assert.match(
    trySh(
      ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"],
      vault,
    ),
    /^\?\? cards\/notes\/падхук\.md$/mu,
    "брошенная правка не живёт в чужом индексе до следующего коммита",
  );

  rmSync(join(vault, ".git", "hooks", "pre-commit"));
  const later = await tool.card(
    card({ body: "Следующая карточка.", operation: "ADD", title: "Следующая" }),
  );
  assert.equal(later.ok, true, later.error);
  assert.deepEqual(touched(vault), ["cards/notes/следующая.md"]);
  assert.deepEqual(subjects(vault), ["card следующая: ADD"]);
});
test("vault внутри чужого репозитория: память не уезжает в чужую историю", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "iva-parent-"));
  t.after(() =>
    rmSync(parent, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    }),
  );
  sh(["init", "-q", "-b", "main"], parent);
  sh(["config", "user.email", "owner@example.com"], parent);
  sh(["config", "user.name", "Owner"], parent);
  writeFileSync(join(parent, "SOURCE.md"), "чужой репозиторий\n");
  sh(["add", "-A"], parent);
  sh(["commit", "-q", "-m", "parent base"], parent);
  const vault = join(parent, "vault");
  mkdirSync(join(vault, "cards", "notes"), { recursive: true });
  cpSync(SCHEMA, join(vault, "schema.json"));
  process.env.ASSISTANT_VAULT_DIR = vault;

  const { logged, value: result } = await journal(() =>
    tool.card(card({ operation: "ADD", title: "Внутри" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(join(vault, "cards", "notes", "внутри.md")), true);
  assert.deepEqual(
    sh(["log", "--pretty=%s"], parent).split("\n"),
    ["parent base"],
    "чужой репозиторий не знает о записи в память",
  );
  assert.equal(trySh(["status", "--porcelain"], parent), "?? vault/");
  assert.match(logged, /^\[vault-commit\] card внутри: ADD: /u);
  assert.equal(logged.split("\n").length, 1, "причина отказа - одна строка");
});
test("git не ответил за таймаут: причина - таймаут, а не «нет в PATH»", async (t) => {
  const vault = makeVault(t);
  hook(vault, "sleep 40");
  const started = Date.now();
  const { logged, value: result } = await journal(() =>
    tool.card(card({ operation: "ADD", title: "Тишина" })),
  );
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(join(vault, "cards", "notes", "тишина.md")), true);
  assert.match(logged, /не ответил/u);
  assert.doesNotMatch(logged, /PATH/u);
  assert.ok(elapsed < 20_000, `запись ждала ${String(elapsed)} мс`);
});
test("в журнал уходит причина отказа, а не подсказка git", async (t) => {
  const vault = makeVault(t);
  writeFileSync(join(vault, ".gitignore"), "cards/notes/*\n");
  sh(["add", "--", ".gitignore"], vault);
  sh(["commit", "-q", "-m", "ignore cards"], vault);

  const { logged, value: result } = await journal(() =>
    tool.card(card({ operation: "ADD", title: "Скрытая" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /ignored by one of your \.gitignore files/u);
  assert.doesNotMatch(logged, /hint:/u);
});
test("read-only .git: причина в журнале, без пустого ожидания", async (t) => {
  const vault = makeVault(t);
  chmodSync(join(vault, ".git"), 0o500);
  const started = Date.now();
  const outcome = await journal(async () => {
    try {
      return await tool.card(card({ operation: "ADD", title: "Закрытый" }));
    } finally {
      chmodSync(join(vault, ".git"), 0o700);
    }
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.value.ok, true, outcome.value.error);
  assert.match(outcome.logged, /Permission denied/u);
  assert.ok(elapsed < 700, `запись ждала ${String(elapsed)} мс без причины`);
});
