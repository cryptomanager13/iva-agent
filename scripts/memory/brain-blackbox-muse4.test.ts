// PBT-MUSE-4: ночная свёртка как чёрный ящик. Гоняем scripts/memory/brain.ts
// дочерним процессом на игрушечных вольтах: пустой вольт, вольт без git,
// обрыв посреди записи (успешный шаг без отчёта). Без сети, без агента, каждый
// прогон с таймаутом. Production-код не тронут.
//
// SEED: сценарии детерминированы (фиксированные деревья и фейковые бинарники);
// воспроизведение — сам файл. Чистим в finally каждого теста: file-level after()
// под --test-name-pattern может сработать до завершения живого теста.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRAIN = join(ROOT, "scripts/memory/brain.ts");

const worlds: string[] = [];
function world(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  worlds.push(dir);
  return dir;
}
function cleanup(): void {
  for (const dir of worlds.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

type Run = { status: number; stdout: string; stderr: string };

function runBrain(env: Record<string, string>, binDir?: string): Run {
  const child = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/memory/brain.ts")],
    {
      cwd: ROOT,
      timeout: 90000,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH,
        ...env,
      },
    },
  );
  return {
    status: child.status ?? -1,
    stdout: String(child.stdout ?? ""),
    stderr: String(child.stderr ?? ""),
  };
}

function fakeBin(exitCode: number): string {
  const bin = world("iva-muse4-bin-");
  writeFileSync(bin + "/uv", `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(bin + "/uv", 0o755);
  // gh глушим всегда: иначе ensureRemote на настоящей машине с живым gh полезет
  // создавать репозиторий и трогать remote.
  writeFileSync(bin + "/gh", "#!/bin/sh\nexit 1\n");
  chmodSync(bin + "/gh", 0o755);
  return bin;
}

function gitInit(vault: string): void {
  const run = spawnSync("git", ["init", "-q", vault], { encoding: "utf8" });
  assert.equal(run.status, 0, `git init: ${run.stderr}`);
}

await test("пустого вольта нет: честный exit 1", () => {
  try {
    const data = world("iva-muse4-data-");
    const missing = join(data, "no-vault-here");
    const run = runBrain({
      ASSISTANT_VAULT_DIR: missing,
      ASSISTANT_DATA_DIR: data,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /vault not found/);
  } finally {
    cleanup();
  }
});

// F-BRAIN: шаг supersede «успешен», а отчёта нет (обрыв посреди записи,
// стёртый .graph, чужой формат) — это провал ШАГА с понятной причиной: ночь идёт
// по пути провала (алерт maintenance со списком шагов), а не падает необработанным
// исключением без бэкапа и без оповещения.
await test("F-BRAIN: успех без отчёта — провал шага, а не падение ночи", () => {
  try {
    const vault = world("iva-muse4-vault-");
    const data = world("iva-muse4-data-");
    gitInit(vault);
    const bin = fakeBin(0);
    const run = runBrain(
      {
        ASSISTANT_VAULT_DIR: vault,
        ASSISTANT_DATA_DIR: data,
      },
      bin,
    );
    const out = run.stdout + run.stderr;
    assert.equal(run.status, 1);
    assert.match(out, /failed at: supersede|не прошёл на шагах: supersede/);
    assert.ok(!/Error: ENOENT/.test(out), "без необработанного стека");
    assert.ok(!run.stdout.includes("brain: done"));
  } finally {
    cleanup();
  }
});

// F-BRAIN, вторая половина: шаг, убитый сигналом, — тоже провал (run() считал
// status null успехом). Фейковый uv вешается сам на cleanup.py, остальное exit 0
// без отчёта: в списке провала оба шага, cleanup первым.
await test("F-BRAIN: убитый сигналом шаг считается провалом", () => {
  try {
    const vault = world("iva-muse4-vault-");
    const data = world("iva-muse4-data-");
    gitInit(vault);
    const bin = world("iva-muse4-bin-");
    writeFileSync(
      bin + "/uv",
      '#!/bin/sh\ncase "$*" in *cleanup.py*) kill -TERM $$;; *) exit 0;; esac\n',
    );
    chmodSync(bin + "/uv", 0o755);
    writeFileSync(bin + "/gh", "#!/bin/sh\nexit 1\n");
    chmodSync(bin + "/gh", 0o755);
    const run = runBrain(
      {
        ASSISTANT_VAULT_DIR: vault,
        ASSISTANT_DATA_DIR: data,
      },
      bin,
    );
    const out = run.stdout + run.stderr;
    assert.equal(run.status, 1);
    assert.match(out, /failed at: .*cleanup|не прошёл на шагах: .*cleanup/);
    assert.match(out, /supersede/);
    assert.ok(!/Error: ENOENT/.test(out), "без необработанного стека");
  } finally {
    cleanup();
  }
});

// Вольт без git и мёртвый uv: ночь честно говорит «бэкап отложен» и выходит 1 —
// спроектированный путь, фиксируем что он жив.
await test("вольт без git: понятный отказ вместо падения", () => {
  try {
    const vault = world("iva-muse4-vault-");
    const data = world("iva-muse4-data-");
    const bin = fakeBin(1);
    const run = runBrain(
      {
        ASSISTANT_VAULT_DIR: vault,
        ASSISTANT_DATA_DIR: data,
      },
      bin,
    );
    assert.equal(run.status, 1);
    assert.match(run.stdout + run.stderr, /git status/);
    assert.ok(!run.stdout.includes("brain: done"));
  } finally {
    cleanup();
  }
});

// Без remote локальный коммит всё равно есть: отсутствие remote отменяет только push,
// а память за сутки остаётся в истории vault (иначе у установки без remote нет истории
// памяти вообще).
await test("без remote: ночной коммит есть, push не проходит", () => {
  try {
    const vault = world("iva-muse4-vault-");
    const data = world("iva-muse4-data-");
    gitInit(vault);
    for (const [key, value] of [
      ["user.email", "brain@example.com"],
      ["user.name", "Brain"],
    ])
      assert.equal(
        spawnSync("git", ["-C", vault, "config", key, value]).status,
        0,
      );
    writeFileSync(join(vault, "CORE.md"), "# CORE\n\nФакт дня.\n");
    const run = runBrain(
      {
        ASSISTANT_VAULT_DIR: vault,
        ASSISTANT_DATA_DIR: data,
      },
      fakeBin(0),
    );
    const out = run.stdout + run.stderr;
    assert.match(out, /no remote and gh unavailable — push skipped/);
    const log = spawnSync("git", ["-C", vault, "log", "--pretty=%s"], {
      encoding: "utf8",
    }).stdout;
    assert.match(log, /chore: memory \d{4}-\d{2}-\d{2}/);
    assert.equal(
      spawnSync("git", ["-C", vault, "remote"], {
        encoding: "utf8",
      }).stdout.trim(),
      "",
      "push никуда не ушёл: remote в vault нет",
    );
    assert.equal(
      spawnSync("git", ["-C", vault, "status", "--porcelain"], {
        encoding: "utf8",
      }).stdout,
      "",
    );
  } finally {
    cleanup();
  }
});

void BRAIN;
