/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Ночной brain целиком, живым процессом: единственный способ увидеть, на каком языке он
// говорит и что именно говорит. Телеграма в тесте нет — без токена brain печатает готовый
// текст алерта в stderr, и это ровно та строка, которую увидел бы владелец.
//
// PATH пуст намеренно: без uv, git и gh прогон останавливается на проверке размеров перед
// бэкапом и НИКОГДА не доходит до `gh repo create` — тест не имеет права ничего создать в
// чужом GitHub-аккаунте.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_CAP } from "#lib/core-cap.ts";
import { createCliMain } from "../cli/main.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Run = { code: number | null; stderr: string; dataDir: string };

/** Установка, где ничего внешнего нет: раздутый CORE.md, карточка с открытым фенсом. */
function runBrain(
  t: TestContext,
  language: string | null,
  agentLanguage: string,
): Run {
  const home = mkdtempSync(join(tmpdir(), "iva-brain-alerts-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, "vault with ' quote $ sign");
  const dataDir = join(home, "data");
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(vault, "CORE.md"),
    `# CORE\n\n${"факт. ".repeat(CORE_CAP)}`,
  );
  writeFileSync(
    join(vault, "cards", "broken.md"),
    "---\ntype: note\n---\n\n# Broken\n\nfacts\n\n```bash\nnever closed\n",
  );
  if (language !== null)
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ language }));

  const result = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: "", // ни uv, ни git, ни gh — наружу этот прогон не выйдет
      HOME: home,
      ASSISTANT_VAULT_DIR: vault,
      ASSISTANT_DATA_DIR: dataDir,
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: agentLanguage,
    },
  });
  return { code: result.status, stderr: result.stderr, dataDir };
}

test("brain speaks Russian, says what broke and what to do", (t) => {
  const run = runBrain(t, null, "ru");

  assert.equal(run.code, 1);
  // 1. Механическое обслуживание не прошло: что сломалось → чем грозит → что сделать.
  assert.match(
    run.stderr,
    /Ночной уход за памятью не прошёл на шагах: cleanup/,
  );
  assert.match(run.stderr, /Карточки остаются вне схемы/);
  assert.match(run.stderr, /Выполни на сервере: uv --version/);
  // 2. CORE.md ужат.
  assert.match(
    run.stderr,
    new RegExp(`CORE\\.md вырос за лимит в ${CORE_CAP} знаков`),
  );
  assert.match(run.stderr, /Открой CORE\.md и проверь/);
  // 3. Карточка с незакрытым фенсом — с путём к ней.
  assert.match(run.stderr, /Карточек с незакрытым ```: 1\./);
  assert.match(run.stderr, /cards\/broken\.md/);
  // 4. Бэкап отложен.
  assert.match(run.stderr, /Проверка размеров файлов перед бэкапом не прошла/);
  assert.match(run.stderr, /память ещё не сохранена вне сервера/);
  assert.match(run.stderr, /Выполни на сервере df -h/);
  // Ни одной английской строки из прежних алертов.
  assert.doesNotMatch(run.stderr, /vault maintenance partially failed/);
  assert.doesNotMatch(run.stderr, /Vault health dropped/);
});

test("brain speaks English when the owner picked English", (t) => {
  const run = runBrain(t, "en", "ru");

  assert.equal(run.code, 1);
  assert.match(run.stderr, /Nightly memory care failed at: cleanup/);
  assert.match(run.stderr, /Cards stay off-schema/);
  assert.match(run.stderr, /On the server run: uv --version/);
  assert.match(
    run.stderr,
    new RegExp(`CORE\\.md grew past its ${CORE_CAP}-character cap`),
  );
  assert.match(run.stderr, /Cards with an unclosed ``` fence: 1\./);
  assert.match(run.stderr, /The file-size check before the backup failed/);
  assert.match(run.stderr, /On the server run df -h/);
  // Русского в английском прогоне нет вовсе.
  assert.doesNotMatch(run.stderr, /Ночной уход/);
  assert.doesNotMatch(run.stderr, /Бэкап памяти/);
});

test("settings.language beats the environment, both ways", (t) => {
  assert.match(
    runBrain(t, "ru", "en").stderr,
    /Ночной уход за памятью не прошёл/,
  );
  assert.match(runBrain(t, "en", "ru").stderr, /Nightly memory care failed/);
});

test("an alert that never reached Telegram does not silence the next night", (t) => {
  const first = runBrain(t, null, "ru");
  assert.equal(
    existsSync(join(first.dataDir, "alert-state.json")),
    false,
    "nothing was delivered, so nothing may be recorded as delivered",
  );
});

// Дроссель и текст живут в разных местах, поэтому здесь — только контракт brain.ts: каждая
// алерт уходит через alert() (то есть через дроссель) и несёт пару локалей.
test("every brain alert goes through the throttle and carries both locales", () => {
  const source = readFileSync(join(ROOT, "scripts/memory/brain.ts"), "utf8");

  const keys = [...source.matchAll(/await alert\(\s*"([a-z-]+)"/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual([...keys].sort(), [
    "authored-tree",
    "backup-oversize",
    "backup-push",
    "backup-scan",
    "core-cap",
    "health-drop",
    "health-history-corrupt",
    "maintenance",
    "supersede-unreadable",
    "unclosed-fence",
    "vault-remote",
  ]);
  assert.equal(new Set(keys).size, keys.length, "one key per problem");

  // Единственный прямой вызов транспорта — внутри alert(); всё остальное дросселируется.
  assert.equal(source.split("telegram(message)").length - 1, 1);
  assert.doesNotMatch(source, /await telegram\(/u);

  // Каждая проблема умеет и «ушла»: рецидив после починки говорит сразу.
  const cleared = [
    ...source.matchAll(/(?<!await )cleared\("([a-z-]+)"\)/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    [...cleared].sort(),
    [...keys].sort(),
    "every problem that can be alerted must also be forgettable, or a relapse waits a week",
  );

  // Эталонный алерт: обе локали говорят, что сломалось, чем грозит и что сделать.
  assert.match(
    source,
    /Memory is not backed up: the vault has no git remote\./u,
  );
  assert.match(source, /Память не бэкапится: у vault нет git remote\./u);
  assert.match(source, /"\(repo scope\)\. The nightly brain then creates/u);
  assert.match(source, /"\(scope repo\)\. Ночной brain сам создаст/u);
  assert.match(source, /Supersede skipped unreadable Cards\./u);
  assert.match(source, /Supersede пропустил нечитаемые карточки\./u);
});

// Щель B-6: отчёт-не-объект шаг уже валит, а запись ЧУЖОЙ формы внутри списка
// отфильтровывалась в ноль — шаг зелёный, алерт гасится, владелец ничего не узнаёт.
// Сегодня supersede.py эмитит ровно три причины, поэтому гвард стоит на границе разбора.
for (const [what, entry, field] of [
  [
    "чужие имена полей",
    { file: "cards/private-name.md", why: "нипочему" },
    "path",
  ],
  ["нет пути", { reason: "read_error" }, "path"],
  ["путь не строка", { path: 42, reason: "read_error" }, "path"],
  [
    "неизвестная причина",
    { path: "cards/x.md", reason: "moon_phase" },
    "reason",
  ],
  ["запись не объект", "cards/x.md", "is not an object"],
] as const) {
  test(`Supersede report entry with ${what} fails the step instead of counting zero`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "iva-supersede-shape-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const vault = join(home, "vault");
    const dataDir = join(home, "data");
    const bin = join(home, "bin");
    mkdirSync(join(vault, "cards"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(vault, "CORE.md"), "# CORE\n");
    writeFileSync(
      join(vault, "cards", "ok.md"),
      "---\ntype: note\n---\n\n# Ok\n\nfacts\n",
    );

    const uv = join(bin, "uv");
    writeFileSync(
      uv,
      `#!/bin/sh
/bin/mkdir -p .graph
printf '%s\\n' '${JSON.stringify({ skipped: [entry] })}' > .graph/supersede-report.json
exit 0
`,
    );
    chmodSync(uv, 0o755);

    const run = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: bin,
        ASSISTANT_VAULT_DIR: vault,
        ASSISTANT_DATA_DIR: dataDir,
        ASSISTANT_TIMEZONE: "UTC",
        AGENT_LANGUAGE: "en",
      },
    });

    assert.equal(run.status, 1, run.stderr);
    assert.match(
      run.stderr,
      new RegExp(`supersede report entry 0 .*${field}`, "u"),
      run.stderr,
    );
    // Шаг именно провален: он назван в общем алерте ночи, а не просто промолчал.
    assert.match(
      run.stderr,
      /Nightly memory care failed at: [^.]*supersede/u,
      run.stderr,
    );
    // Ноль пропущенных карточек больше не объявляется: шаг провален, а не чист.
    assert.doesNotMatch(
      run.stderr,
      /Supersede skipped unreadable Cards\./u,
      run.stderr,
    );
    // Путь карточки — данные владельца, в журнал он не идёт, как и у соседних проверок.
    assert.doesNotMatch(run.stderr, /private-name/u, run.stderr);
  });
}

test("a failed supersede step suppresses neither the missed Cards nor the fence alert", (t) => {
  // Провальный шаг ничего не гасит: счёт пропущенных карточек заведомо неполон, значит и
  // «эти карточки уже учтены» сказать нельзя — карточка с незакрытым фенсом обязана
  // остаться в алерте фенса, иначе владелец про неё не узнает вовсе.
  const home = mkdtempSync(join(tmpdir(), "iva-supersede-failed-skip-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, "vault");
  const dataDir = join(home, "data");
  const bin = join(home, "bin");
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(vault, "CORE.md"), "# CORE\n");
  writeFileSync(
    join(vault, "cards", "unreadable.md"),
    "---\ntype: note\n---\n```\nnever closed\n",
  );

  // Валидная запись (карточка с фенсом) плюс чужая: шаг провален, разбор неполон.
  const skipped = [
    { path: "cards/unreadable.md", reason: "malformed_frontmatter" },
    { file: "cards/private-name.md", why: "нипочему" },
  ];
  const uv = join(bin, "uv");
  writeFileSync(
    uv,
    `#!/bin/sh
/bin/mkdir -p .graph
printf '%s\\n' '${JSON.stringify({ skipped })}' > .graph/supersede-report.json
exit 0
`,
  );
  chmodSync(uv, 0o755);

  const run = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: bin,
      ASSISTANT_VAULT_DIR: vault,
      ASSISTANT_DATA_DIR: dataDir,
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: "en",
    },
  });

  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /Nightly memory care failed at: [^.]*supersede/u,
    run.stderr,
  );
  // Алерта про пропущенные карточки нет: шаг провален, а не чист.
  assert.doesNotMatch(
    run.stderr,
    /Supersede skipped unreadable Cards\./u,
    run.stderr,
  );
  // Провальный шаг не гасит и алерт фенса: карточка из неполного списка остаётся в нём.
  assert.match(
    run.stderr,
    /Cards with an unclosed ``` fence: 1\./u,
    run.stderr,
  );
  assert.match(run.stderr, /cards\/unreadable\.md/u, run.stderr);
  // Чужая запись в журнал не течёт.
  assert.doesNotMatch(run.stderr, /private-name/u, run.stderr);
});

test("a reason that looks like a path is never printed in the journal", (t) => {
  // Значение reason печатается, только если оно похоже на причину supersede.py
  // (/^[a-z0-9_]{1,40}$/): чужой путь в журнал не уезжает.
  const home = mkdtempSync(join(tmpdir(), "iva-supersede-reason-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, "vault");
  const dataDir = join(home, "data");
  const bin = join(home, "bin");
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(vault, "CORE.md"), "# CORE\n");
  writeFileSync(
    join(vault, "cards", "ok.md"),
    "---\ntype: note\n---\n\n# Ok\n\nfacts\n",
  );

  const uv = join(bin, "uv");
  writeFileSync(
    uv,
    `#!/bin/sh
/bin/mkdir -p .graph
printf '%s\\n' '${JSON.stringify({ skipped: [{ path: "cards/x.md", reason: "../../etc/passwd" }] })}' > .graph/supersede-report.json
exit 0
`,
  );
  chmodSync(uv, 0o755);

  const run = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: bin,
      ASSISTANT_VAULT_DIR: vault,
      ASSISTANT_DATA_DIR: dataDir,
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: "en",
    },
  });

  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /supersede report entry 0 has an unknown "reason"/u,
    run.stderr,
  );
  assert.doesNotMatch(run.stderr, /passwd/u, run.stderr);
});

test("Supersede skip report raises one actionable throttled Alert without Card data", (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-supersede-alert-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, "vault");
  const dataDir = join(home, "data");
  const bin = join(home, "bin");
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(vault, "CORE.md"), "# CORE\n");
  writeFileSync(
    join(vault, "cards", "private-name.md"),
    "---\ntype: note\nprivate: [broken\n---\n```\nsecret bytes\n",
  );
  writeFileSync(
    join(vault, "cards", "readable-unclosed.md"),
    "---\ntype: note\n---\n```\nreadable bytes\n",
  );

  const skipped = [
    { path: "cards/private-name.md", reason: "malformed_frontmatter" },
  ];
  const uv = join(bin, "uv");
  writeFileSync(
    uv,
    `#!/bin/sh
/bin/mkdir -p .graph
printf '%s\\n' '${JSON.stringify({ skipped })}' > .graph/supersede-report.json
exit 0
`,
  );
  chmodSync(uv, 0o755);

  const run = () =>
    spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: bin,
        ASSISTANT_VAULT_DIR: vault,
        ASSISTANT_DATA_DIR: dataDir,
        ASSISTANT_TIMEZONE: "UTC",
        AGENT_LANGUAGE: "en",
      },
    });

  const first = run();
  assert.equal(first.status, 1);
  assert.match(first.stderr, /Supersede skipped unreadable Cards\./u);
  assert.match(first.stderr, /Conflicts in 1 Card will not reach Rollup\./u);
  assert.match(first.stderr, /supersede-report\.json/u);
  assert.doesNotMatch(first.stderr, /private-name/u);
  assert.doesNotMatch(first.stderr, /private-bytes/u);
  assert.doesNotMatch(first.stderr, /secret bytes/u);
  assert.match(first.stderr, /Cards with an unclosed ``` fence: 1\./u);
  assert.match(first.stderr, /cards\/readable-unclosed\.md/u);

  const command = first.stderr.match(
    /Run this command:\n([^\n]+)\nThen open this report/u,
  )?.[1];
  assert.ok(command, first.stderr);
  const reportedPath = first.stderr.match(
    /Then open this report:\n([^\n]+)\nRepair the listed Cards/u,
  )?.[1];
  assert.ok(reportedPath, first.stderr);
  rmSync(join(vault, ".graph", "supersede-report.json"), { force: true });
  const replay = spawnSync("/bin/sh", ["-c", command], {
    cwd: home,
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    },
  });
  assert.equal(replay.status, 0, replay.stderr);
  const namedReport = spawnSync("/bin/sh", ["-c", `test -f ${reportedPath}`], {
    cwd: home,
    encoding: "utf8",
  });
  assert.equal(namedReport.status, 0, namedReport.stderr);
  const replayedReport: unknown = JSON.parse(
    readFileSync(join(vault, ".graph", "supersede-report.json"), "utf8"),
  );
  assert.deepEqual(replayedReport, { skipped });

  const essence = createHash("sha256")
    .update(JSON.stringify(skipped))
    .digest("hex");
  writeFileSync(
    join(dataDir, "alert-state.json"),
    JSON.stringify({
      "supersede-unreadable": { essence, lastSentAt: Date.now() },
    }),
  );
  const second = run();
  assert.equal(second.status, 1);
  assert.doesNotMatch(second.stderr, /Supersede skipped unreadable Cards\./u);
  assert.match(
    second.stdout,
    /supersede-unreadable is unchanged since the last alert — not repeated/u,
  );
});

test("nightly brain repairs title links before measuring health", (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-brain-graph-fix-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, "vault");
  const dataDir = join(home, "data");
  const bin = join(home, "bin");
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(vault, "CORE.md"), "# CORE\n");
  writeFileSync(
    join(vault, "cards", "dev-tools.md"),
    "# Рубрика инструментов\n",
  );
  // Схема именно в vault: тогда шаг получает предсказуемый путь схемы.
  writeFileSync(join(vault, "schema.json"), JSON.stringify({ node_types: {} }));

  const callLog = join(home, "uv-calls.log");
  const uv = join(bin, "uv");
  writeFileSync(
    uv,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${callLog}'
/bin/mkdir -p .graph
printf '%s\\n' '${JSON.stringify({ skipped: [] })}' > .graph/supersede-report.json
exit 0
`,
  );
  chmodSync(uv, 0o755);

  const result = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: bin,
      ASSISTANT_VAULT_DIR: vault,
      ASSISTANT_DATA_DIR: dataDir,
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: "en",
    },
  });

  const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean);
  const enforce = calls.findIndex((call) => call.includes("enforce.py"));
  const fix = calls.findIndex((call) => call.includes("graph.py fix"));
  const health = calls.findIndex((call) => call.includes("graph.py health"));
  const detail = `${result.stdout}${result.stderr}`;
  assert.notEqual(enforce, -1, detail);
  assert.ok(fix !== -1, detail);
  assert.notEqual(health, -1, detail);
  assert.equal(
    calls.filter((call) => call.includes("graph.py fix")).length,
    1,
    "graph.fix runs exactly once",
  );
  const fixCall = calls[fix];
  assert.ok(fixCall, detail);
  assert.match(fixCall, /--apply/u);
  assert.match(fixCall, /--as-of \d{4}-\d{2}-\d{2}/u);
  assert.ok(
    fixCall.includes(join(vault, "schema.json")),
    `graph.fix must carry the schema path, got: ${fixCall}`,
  );
  assert.ok(
    enforce < fix && fix < health,
    `expected enforce < graph.fix < graph.health, got: ${calls.join(" | ")}`,
  );
});

// ── Установка со сломанным agent/ ────────────────────────────────────────────────────────
// Brain копируется на «остров»: свой package.json без алиаса #lib и без каталога agent/.
// loadCardTools() там падает, cards === null — то есть проверить размер ядра и просканировать
// фенсы нечем. Забывать в этом состоянии нечего: отметка недельного дросселя обязана уцелеть,
// иначе установка с мигающим деревом теряет дроссель и получает алерты каждую ночь.
function runBrainWithoutTree(
  t: TestContext,
  options: {
    health?: number[];
    healthBytes?: Uint8Array;
    corruptAlertLastSentAt?: number;
    language?: "ru" | "en";
  } = {},
): {
  code: number | null;
  stdout: string;
  stderr: string;
  healthBytes?: Buffer;
  state: Record<string, { essence?: string; lastSentAt?: number }>;
} {
  const home = mkdtempSync(join(tmpdir(), "iva-brain-island-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const island = join(home, "island");
  mkdirSync(join(island, "scripts/memory"), { recursive: true });
  mkdirSync(join(island, "scripts/lib"), { recursive: true });
  mkdirSync(join(island, "packages/data-dir"), { recursive: true });
  mkdirSync(join(island, "packages/vault-dir"), { recursive: true });
  mkdirSync(join(island, "packages/timezone"), { recursive: true });
  writeFileSync(
    join(island, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  copyFileSync(
    join(ROOT, "scripts/memory/brain.ts"),
    join(island, "scripts/memory/brain.ts"),
  );
  for (const name of [
    "data-dir.ts",
    "memory-maintenance.ts",
    "notice-policy.ts",
    "notice.ts",
    "notification-chat.ts",
    "timezone.ts",
    "vault-boundary.ts",
    // brain зовёт шов коммита через него, и острову он нужен так же, как сам brain.
    "vault-pair.ts",
  ])
    copyFileSync(
      join(ROOT, "scripts/lib", name),
      join(island, "scripts/lib", name),
    );
  for (const name of ["index.ts", "package.json"])
    copyFileSync(
      join(ROOT, "packages/data-dir", name),
      join(island, "packages/data-dir", name),
    );
  for (const name of ["index.ts", "package.json"])
    copyFileSync(
      join(ROOT, "packages/timezone", name),
      join(island, "packages/timezone", name),
    );
  for (const name of ["index.ts", "package.json"])
    copyFileSync(
      join(ROOT, "packages/vault-dir", name),
      join(island, "packages/vault-dir", name),
    );

  const vault = join(home, "vault");
  const dataDir = join(home, "data");
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(vault, "CORE.md"), "x".repeat(CORE_CAP * 2));
  writeFileSync(
    join(vault, "cards", "broken.md"),
    "---\ntype: note\n---\n\nfacts\n\n```bash\nnever closed\n",
  );
  // История здоровья читается без authored tree, поэтому ею и проверяется вторая половина
  // правила: где сравнить БЫЛО чем и падения нет — отметка снимается.
  if (options.health) {
    mkdirSync(join(vault, ".graph"), { recursive: true });
    writeFileSync(
      join(vault, ".graph/health-history.json"),
      JSON.stringify(
        options.health.map((health_score, index) => ({
          date: `2026-08-${String(index + 1).padStart(2, "0")}`,
          health_score,
        })),
      ),
    );
  }
  if (options.healthBytes) {
    mkdirSync(join(vault, ".graph"), { recursive: true });
    writeFileSync(
      join(vault, ".graph/health-history.json"),
      options.healthBytes,
    );
  }

  const week = 7 * 24 * 60 * 60 * 1000;
  const alertState: Record<string, { essence: string; lastSentAt: number }> = {
    "core-cap": { essence: "clamped", lastSentAt: Date.now() - week / 2 },
    "unclosed-fence": {
      essence: "cards/broken.md",
      lastSentAt: Date.now() - week / 2,
    },
    "health-drop": { essence: "dropping", lastSentAt: Date.now() - week / 2 },
  };
  if (options.corruptAlertLastSentAt !== undefined)
    alertState["health-history-corrupt"] = {
      essence: "corrupt",
      lastSentAt: options.corruptAlertLastSentAt,
    };
  writeFileSync(join(dataDir, "alert-state.json"), JSON.stringify(alertState));

  const result = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
    cwd: island,
    encoding: "utf8",
    env: {
      PATH: "",
      HOME: home,
      ASSISTANT_VAULT_DIR: vault,
      ASSISTANT_DATA_DIR: dataDir,
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: options.language ?? "ru",
    },
  });
  const healthPath = join(vault, ".graph/health-history.json");
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    healthBytes: existsSync(healthPath) ? readFileSync(healthPath) : undefined,
    state: JSON.parse(
      readFileSync(join(dataDir, "alert-state.json"), "utf8"),
    ) as Record<string, { essence?: string; lastSentAt?: number }>,
  };
}

test("a broken agent/ does not erase the throttle of what it could not check", (t) => {
  const run = runBrainWithoutTree(t);

  assert.equal(run.code, 1);
  assert.match(run.stderr, /Файлы самой Ивы не читаются/, "the tree is gone");

  // Проверить эти две проблемы было нечем — отметки на месте, дроссель жив.
  assert.equal(
    typeof run.state["core-cap"]?.lastSentAt,
    "number",
    "the CORE cap was never measured, so its alert must not be forgotten",
  );
  assert.equal(
    typeof run.state["unclosed-fence"]?.lastSentAt,
    "number",
    "the fence scan never ran, so its alert must not be forgotten",
  );
  // Истории здоровья в этой фикстуре нет вовсе: сравнивать было нечего, значит и забывать
  // нечего — то же правило, что у двух проверок выше.
  assert.equal(
    typeof run.state["health-drop"]?.lastSentAt,
    "number",
    "with no health history there was no comparison, so nothing may be forgotten",
  );
});

// Совет владельцу обязан называть команду, которая есть: `iva repair` годами стоял в этом
// алерте, а такой команды в CLI не было. Каждая `iva <имя>` в тексте — ключ таблицы CLI.
test("the broken-tree alert names only commands that exist", (t) => {
  const commands = createCliMain(ROOT).commands;
  for (const language of ["ru", "en"] as const) {
    const { stderr } = runBrainWithoutTree(t, { language });
    const alert = stderr
      .split("\n")
      .find((line) => /Файлы самой Ивы|Iva's own files/u.test(line));
    assert.ok(alert, `${language}: the broken-tree alert is missing`);

    const cli = [...alert.matchAll(/\biva ([a-z-]+)/gu)].map((m) => m[1]);
    assert.ok(cli.length > 0, `${language}: no remedy named`);
    for (const name of cli)
      assert.ok(Object.hasOwn(commands, name), `${language}: no "iva ${name}"`);
  }
});

test("a check that did run and found nothing does clear its alert", (t) => {
  // Та же сломанная установка, но история здоровья на месте и падения в ней нет. Иначе
  // предыдущий тест доказывал бы лишь то, что запись невозможно снять вообще.
  const run = runBrainWithoutTree(t, { health: [80, 85] });

  assert.equal(run.code, 1);
  assert.equal(
    "health-drop" in run.state,
    false,
    "the history was readable and showed no drop, so that alert is forgotten",
  );
  // Соседи, которых проверить было нечем, по-прежнему на месте.
  assert.equal(typeof run.state["core-cap"]?.lastSentAt, "number");
  assert.equal(typeof run.state["unclosed-fence"]?.lastSentAt, "number");
});

test("corrupt health history is preserved and raises an actionable alert", (t) => {
  const raw = Buffer.from([
    0x5b, 0x7b, 0x22, 0x64, 0x61, 0x74, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22,
    0x7d, 0x5d,
  ]);
  const run = runBrainWithoutTree(t, { healthBytes: raw });

  assert.equal(run.code, 1);
  assert.deepEqual(run.healthBytes, raw);
  assert.match(run.stderr, /health-history\.json повреждён/);
  assert.match(run.stderr, /оставлен без изменений/);
  assert.match(run.stderr, /Перемести.*health-history\.json.*npm run doctor/);
});

test("an unchanged corrupt health history alert is rate-limited", (t) => {
  const run = runBrainWithoutTree(t, {
    healthBytes: Buffer.from("[", "utf8"),
    corruptAlertLastSentAt: Date.now(),
  });

  assert.equal(run.code, 1);
  assert.match(
    run.stdout,
    /health-history-corrupt is unchanged since the last alert — not repeated/,
  );
  assert.doesNotMatch(run.stderr, /health-history\.json повреждён/);
  assert.equal(
    typeof run.state["health-history-corrupt"]?.lastSentAt,
    "number",
  );
});

test("a valid health history clears the corrupt-history throttle", (t) => {
  const run = runBrainWithoutTree(t, {
    health: [80, 85],
    corruptAlertLastSentAt: Date.now(),
  });

  assert.equal(run.code, 1);
  assert.equal("health-history-corrupt" in run.state, false);
});

test("a real corrupt Graph failure produces only its specific alert", (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-brain-real-graph-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, "vault");
  const dataDir = join(home, "data");
  const bin = join(home, "bin");
  const historyPath = join(vault, ".graph/health-history.json");
  const raw = Buffer.from('[{"date":"2026-08-15"', "utf8");
  mkdirSync(join(vault, ".graph"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(historyPath, raw);
  const uv = "/opt/homebrew/bin/uv";
  assert.equal(
    existsSync(uv),
    true,
    "the supported test environment provides uv",
  );
  symlinkSync(uv, join(bin, "uv"));

  const result = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: bin,
      HOME: home,
      TMPDIR: tmpdir(),
      UV_CACHE_DIR: join(home, "uv-cache"),
      ASSISTANT_VAULT_DIR: vault,
      ASSISTANT_DATA_DIR: dataDir,
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: "ru",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /Error: health history is corrupt; left unchanged/,
  );
  assert.deepEqual(readFileSync(historyPath), raw);
  assert.equal(
    result.stderr.match(/health-history\.json повреждён/gu)?.length ?? 0,
    1,
  );
  assert.doesNotMatch(result.stderr, /Ночной уход за памятью не прошёл/);
});
