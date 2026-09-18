/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration. */
// Adversarial lock tests: ownership, stale takeover, crash windows, and path replacement.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import {
  acquireFileLock,
  acquireFileLockSync,
  releaseFileLock,
} from "./fs-atomic.ts";
import {
  MODULE_URL,
  startChild,
  workspace,
} from "./fs-atomic.fixtures.test.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPath(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) || statSync(path).size === 0) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await sleep(5);
  }
}

// ─── лок ───────────────────────────────────────────────────────────────────

test("лок эксклюзивен: проигравший получает null в пределах таймаута, победитель — держатель", async () => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");

  const held = acquireFileLockSync(path, { timeoutMs: 500 });
  assert.ok(held);
  const started = Date.now();
  assert.equal(
    await acquireFileLock(path, { timeoutMs: 100, retryMs: 5 }),
    null,
  );
  assert.equal(acquireFileLockSync(path, { timeoutMs: 100, retryMs: 5 }), null);
  assert.ok(Date.now() - started >= 100, "проигравший обязан реально ждать");

  releaseFileLock(held);
  const next = await acquireFileLock(path, { timeoutMs: 100 });
  assert.ok(next);
  releaseFileLock(next);
  assert.equal(existsSync(path), false);
});

test("лок создаёт недостающий каталог данных", () => {
  const dir = workspace();
  const path = join(dir, "data", "tasks.json.lock");
  const held = acquireFileLockSync(path, { timeoutMs: 100 });
  assert.ok(held);
  releaseFileLock(held);
});

test("протухший лок отбирается, свежий — нет", () => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  const original = acquireFileLockSync(path, { timeoutMs: 100 });
  assert.ok(original);

  assert.equal(
    acquireFileLockSync(path, { timeoutMs: 60, staleMs: 60_000, retryMs: 5 }),
    null,
    "свежий чужой лок неприкосновенен",
  );

  const past = new Date(Date.now() - 31_000);
  utimesSync(path, past, past);
  const stolen = acquireFileLockSync(path, { timeoutMs: 60, staleMs: 30_000 });
  assert.ok(stolen, "протухший лок обязан быть отобран");
  releaseFileLock(original);
  releaseFileLock(stolen);
});

test("держатель, убитый под локом, блокирует до протухания и не дальше", async (t) => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  const source = [
    `import { acquireFileLockSync } from ${JSON.stringify(MODULE_URL)};`,
    "const [path] = process.argv.slice(1);",
    "acquireFileLockSync(path, { timeoutMs: 1000 });",
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");

  const child = await startChild(source, [path]);
  t.after(() => child.kill("SIGKILL"));
  child.kill("SIGKILL");
  await once(child, "exit");

  assert.ok(existsSync(path), "лок мёртвого держателя остаётся на диске");
  assert.equal(
    await acquireFileLock(path, { timeoutMs: 60, staleMs: 60_000, retryMs: 5 }),
    null,
    "пока лок не протух, преемник ждёт",
  );

  await sleep(60);
  const successor = await acquireFileLock(path, {
    timeoutMs: 200,
    staleMs: 50,
    retryMs: 5,
  });
  assert.ok(successor, "протухший лок мёртвого держателя обязан быть отобран");
  releaseFileLock(successor);
});

test("release снимает только свой лок: запоздавший держатель не трогает преемника", () => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");

  const evicted = acquireFileLockSync(path, { timeoutMs: 100 });
  assert.ok(evicted);
  const past = new Date(Date.now() - 31_000);
  utimesSync(path, past, past);
  const successor = acquireFileLockSync(path, {
    timeoutMs: 100,
    staleMs: 30_000,
  });
  assert.ok(successor);
  assert.notEqual(evicted.token, successor.token);

  releaseFileLock(evicted); // запоздавший release вытесненного держателя
  assert.equal(existsSync(path), true, "лок преемника обязан остаться");
  releaseFileLock(successor);
  assert.equal(existsSync(path), false);
  releaseFileLock(successor); // повторный release уже снятого лока — не ошибка
});

test("release interleaving cannot delete a successor — sync and async owners", async (t) => {
  for (const owner of ["sync", "async"] as const) {
    const dir = workspace();
    const path = join(dir, `${owner}.lock`);
    const observed = join(dir, `${owner}.release-observed`);
    const proceed = join(dir, `${owner}.release-proceed`);
    const source = [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { join } from "node:path";',
      `const atomic = await import(${JSON.stringify(MODULE_URL)});`,
      "const [path, observed, proceed, owner] = process.argv.slice(1);",
      "const held = owner === 'sync'",
      "  ? atomic.acquireFileLockSync(path, { timeoutMs: 1000 })",
      "  : await atomic.acquireFileLock(path, { timeoutMs: 1000 });",
      "if (!held) throw new Error('owner failed');",
      "const directoryProtocol = fs.statSync(path).isDirectory();",
      "const ownerPath = join(path, `.owner-${held.token}`);",
      "const originalRead = fs.readFileSync;",
      "const originalRm = fs.rmSync;",
      "let paused = false;",
      "const pause = () => {",
      "  paused = true;",
      "  fs.writeFileSync(observed, 'ready');",
      "  const wait = new Int32Array(new SharedArrayBuffer(4));",
      "  while (!fs.existsSync(proceed)) Atomics.wait(wait, 0, 0, 5);",
      "};",
      "fs.readFileSync = function(candidate, ...args) {",
      "  const value = originalRead.call(this, candidate, ...args);",
      "  if (!directoryProtocol && !paused && String(candidate) === path) pause();",
      "  return value;",
      "};",
      "fs.rmSync = function(candidate, ...args) {",
      "  if (directoryProtocol && !paused && String(candidate) === ownerPath) {",
      "    const value = originalRm.call(this, candidate, ...args);",
      "    pause();",
      "    return value;",
      "  }",
      "  return originalRm.call(this, candidate, ...args);",
      "};",
      "syncBuiltinESMExports();",
      'process.stdout.write("ready\\n");',
      "atomic.releaseFileLock(held);",
    ].join("\n");

    const child = await startChild(source, [path, observed, proceed, owner]);
    t.after(() => child.kill("SIGKILL"));
    await waitForPath(observed);
    const past = new Date(Date.now() - 31_000);
    utimesSync(path, past, past);
    const successor =
      owner === "sync"
        ? await acquireFileLock(path, {
            timeoutMs: 500,
            staleMs: 30_000,
            retryMs: 5,
          })
        : acquireFileLockSync(path, {
            timeoutMs: 500,
            staleMs: 30_000,
            retryMs: 5,
          });
    assert.ok(successor);
    writeFileSync(proceed, "go");
    await once(child, "exit");

    assert.equal(existsSync(path), true, "старый release удалил successor");
    assert.equal(
      acquireFileLockSync(path, { timeoutMs: 60, retryMs: 5 }),
      null,
      "successor обязан оставаться эксклюзивным",
    );
    releaseFileLock(successor);
  }
});

test("a crashed empty lock directory is recovered without two winners", async (t) => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  const crashSource = [
    'import { mkdirSync } from "node:fs";',
    "const [path] = process.argv.slice(1);",
    "mkdirSync(path, { mode: 0o700 });",
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const crashed = await startChild(crashSource, [path]);
  t.after(() => crashed.kill("SIGKILL"));
  crashed.kill("SIGKILL");
  await once(crashed, "exit");
  assert.equal(statSync(path).isDirectory(), true);

  assert.equal(
    acquireFileLockSync(path, {
      timeoutMs: 40,
      staleMs: 60_000,
      retryMs: 5,
    }),
    null,
    "fresh empty directory may still belong to a pre-entry owner",
  );

  const past = new Date(Date.now() - 31_000);
  utimesSync(path, past, past);
  const go = join(dir, "go");
  const release = join(dir, "release");
  const syncResult = join(dir, "sync-result.json");
  const asyncResult = join(dir, "async-result.json");
  const source = [
    `const atomic = await import(${JSON.stringify(MODULE_URL)});`,
    'const fs = await import("node:fs");',
    "const [path, go, release, result, kind] = process.argv.slice(1);",
    "const wait = new Int32Array(new SharedArrayBuffer(4));",
    'process.stdout.write("ready\\n");',
    "while (!fs.existsSync(go)) Atomics.wait(wait, 0, 0, 5);",
    "const options = { timeoutMs: 250, staleMs: 30_000, retryMs: 5 };",
    "const held = kind === 'sync'",
    "  ? atomic.acquireFileLockSync(path, options)",
    "  : await atomic.acquireFileLock(path, options);",
    "fs.writeFileSync(result, JSON.stringify({ acquired: held !== null }));",
    "if (held) {",
    "  while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 5);",
    "  atomic.releaseFileLock(held);",
    "}",
    'process.stdout.write("done\\n");',
  ].join("\n");
  const syncChild = await startChild(source, [
    path,
    go,
    release,
    syncResult,
    "sync",
  ]);
  const asyncChild = await startChild(source, [
    path,
    go,
    release,
    asyncResult,
    "async",
  ]);
  t.after(() => syncChild.kill("SIGKILL"));
  t.after(() => asyncChild.kill("SIGKILL"));
  writeFileSync(go, "go");
  await Promise.all([waitForPath(syncResult), waitForPath(asyncResult)]);

  const outcomes = [syncResult, asyncResult].map(
    (result) =>
      JSON.parse(readFileSync(result, "utf8")) as { acquired: boolean },
  );
  assert.equal(
    outcomes.filter(({ acquired }) => acquired).length,
    1,
    "ровно один contender обязан победить",
  );
  assert.equal(acquireFileLockSync(path, { timeoutMs: 60, retryMs: 5 }), null);
  const exits = [syncChild, asyncChild].map((child) =>
    child.exitCode === null ? once(child, "exit") : Promise.resolve(),
  );
  writeFileSync(release, "release");
  await Promise.all(exits);
  assert.equal(existsSync(path), false);
});

test("success requires one mode-correct token entry", async () => {
  for (const contender of ["sync", "async"] as const) {
    const dir = workspace();
    const path = join(dir, `${contender}.lock`);
    const held =
      contender === "sync"
        ? acquireFileLockSync(path, { timeoutMs: 100, mode: 0o600 })
        : await acquireFileLock(path, { timeoutMs: 100, mode: 0o600 });
    assert.ok(held);

    const ownerPath = join(path, `.owner-${held.token}`);
    assert.deepEqual(readdirSync(path), [`.owner-${held.token}`]);
    const canonicalOwner = statSync(ownerPath, { bigint: true });
    assert.equal(Number(canonicalOwner.mode & 0o777n), 0o600);
    assert.equal(canonicalOwner.nlink, 1n);

    releaseFileLock(held);
    assert.equal(existsSync(path), false);
  }
});

test("legacy v1 lock-files stay opaque even when stale", async () => {
  for (const contender of ["sync", "async"] as const) {
    const dir = workspace();
    const path = join(dir, `${contender}.lock`);
    writeFileSync(path, "legacy-v1-owner", { mode: 0o600 });

    const fresh =
      contender === "sync"
        ? acquireFileLockSync(path, {
            timeoutMs: 40,
            staleMs: 60_000,
            retryMs: 5,
          })
        : await acquireFileLock(path, {
            timeoutMs: 40,
            staleMs: 60_000,
            retryMs: 5,
          });
    assert.equal(fresh, null);
    assert.equal(readFileSync(path, "utf8"), "legacy-v1-owner");

    const past = new Date(Date.now() - 31_000);
    utimesSync(path, past, past);
    const stale =
      contender === "sync"
        ? acquireFileLockSync(path, {
            timeoutMs: 40,
            staleMs: 30_000,
            retryMs: 5,
          })
        : await acquireFileLock(path, {
            timeoutMs: 40,
            staleMs: 30_000,
            retryMs: 5,
          });
    assert.equal(stale, null);
    assert.equal(readFileSync(path, "utf8"), "legacy-v1-owner");
    assert.equal(statSync(path).isFile(), true);
  }
});

test("a hostile canonical symlink is never traversed or cleaned", async () => {
  for (const contender of ["sync", "async"] as const) {
    const dir = workspace();
    const victim = join(dir, "victim");
    const path = join(dir, `${contender}.lock`);
    const token = `00000000-0000-4000-8000-00000000000${
      contender === "sync" ? "3" : "4"
    }`;
    const victimOwner = join(victim, `.owner-${token}`);
    mkdirSync(victim);
    writeFileSync(victimOwner, "do-not-delete", { mode: 0o600 });
    symlinkSync(victim, path, "dir");

    const held =
      contender === "sync"
        ? acquireFileLockSync(path, {
            timeoutMs: 40,
            staleMs: -1,
            retryMs: 5,
          })
        : await acquireFileLock(path, {
            timeoutMs: 40,
            staleMs: -1,
            retryMs: 5,
          });
    assert.equal(held, null);
    assert.equal(readFileSync(victimOwner, "utf8"), "do-not-delete");
    assert.deepEqual(readdirSync(victim), [`.owner-${token}`]);
    assert.equal(realpathSync(path), realpathSync(victim));
  }
});

test("stale cleanup is bound to the inspected lock directory", () => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  const freshToken = "00000000-0000-4000-8000-000000000005";
  const source = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'import { join } from "node:path";',
    `const atomic = await import(${JSON.stringify(MODULE_URL)});`,
    "const [path, freshToken] = process.argv.slice(1);",
    "const old = atomic.acquireFileLockSync(path, { timeoutMs: 100 });",
    "if (!old) throw new Error('old owner failed');",
    "const past = new Date(Date.now() - 31_000);",
    "fs.utimesSync(path, past, past);",
    "const originalLstat = fs.lstatSync;",
    "let swapped = false;",
    "fs.lstatSync = function(candidate, ...args) {",
    "  const value = originalLstat.call(this, candidate, ...args);",
    "  if (!swapped && String(candidate) === path) {",
    "    swapped = true;",
    "    fs.rmSync(path, { recursive: true, force: true });",
    "    fs.mkdirSync(path, { mode: 0o700 });",
    "    fs.closeSync(fs.openSync(join(path, `.owner-${freshToken}`), 'wx', 0o600));",
    "  }",
    "  return value;",
    "};",
    "syncBuiltinESMExports();",
    "const contender = atomic.acquireFileLockSync(path, {",
    "  timeoutMs: 40, staleMs: 30_000, retryMs: 5",
    "});",
    "console.log(JSON.stringify({",
    "  swapped,",
    "  acquired: contender !== null,",
    "  freshOwnerStillExists: fs.existsSync(join(path, `.owner-${freshToken}`))",
    "}));",
  ].join("\n");
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", source, path, freshToken],
      { encoding: "utf8" },
    ),
  ) as {
    swapped: boolean;
    acquired: boolean;
    freshOwnerStillExists: boolean;
  };

  assert.deepEqual(result, {
    swapped: true,
    acquired: false,
    freshOwnerStillExists: true,
  });
});

test("stale cleanup rechecks directory age before takeover — sync and async", () => {
  for (const contender of ["sync", "async"] as const) {
    const dir = workspace();
    const path = join(dir, `${contender}.lock`);
    const freshToken = `00000000-0000-4000-8000-00000000000${
      contender === "sync" ? "6" : "7"
    }`;
    const source = [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { join } from "node:path";',
      `const atomic = await import(${JSON.stringify(MODULE_URL)});`,
      "const [path, freshToken, contender] = process.argv.slice(1);",
      "fs.mkdirSync(path, { mode: 0o700 });",
      "const past = new Date(Date.now() - 31_000);",
      "fs.utimesSync(path, past, past);",
      "const originalLstat = fs.lstatSync;",
      "let ownerCreated = false;",
      "fs.lstatSync = function(candidate, ...args) {",
      "  const value = originalLstat.call(this, candidate, ...args);",
      "  if (!ownerCreated && String(candidate) === path) {",
      "    ownerCreated = true;",
      "    fs.closeSync(fs.openSync(join(path, `.owner-${freshToken}`), 'wx', 0o600));",
      "  }",
      "  return value;",
      "};",
      "syncBuiltinESMExports();",
      "const options = { timeoutMs: 40, staleMs: 30_000, retryMs: 5 };",
      "const held = contender === 'sync'",
      "  ? atomic.acquireFileLockSync(path, options)",
      "  : await atomic.acquireFileLock(path, options);",
      "console.log(JSON.stringify({",
      "  ownerCreated,",
      "  acquired: held !== null,",
      "  freshOwnerStillExists: fs.existsSync(join(path, `.owner-${freshToken}`))",
      "}));",
    ].join("\n");
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", source, path, freshToken, contender],
        { encoding: "utf8" },
      ),
    ) as {
      ownerCreated: boolean;
      acquired: boolean;
      freshOwnerStillExists: boolean;
    };

    assert.deepEqual(result, {
      ownerCreated: true,
      acquired: false,
      freshOwnerStillExists: true,
    });
  }
});

test("мигающий чужой лок не зацикливает захват: дедлайн действует и на пути «лок исчез»", async (t) => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  const source = [
    "import { rmSync, writeFileSync } from 'node:fs';",
    "const [path] = process.argv.slice(1);",
    'process.stdout.write("ready\\n");',
    "const stop = Date.now() + 3000;",
    "while (Date.now() < stop) {",
    "  try { writeFileSync(path, 'blink', { flag: 'wx' }); } catch {}",
    "  try { rmSync(path, { force: true, recursive: true }); } catch {}",
    "}",
  ].join("\n");

  const child = await startChild(source, [path]);
  t.after(() => child.kill("SIGKILL"));

  const started = Date.now();
  const result = acquireFileLockSync(path, {
    timeoutMs: 100,
    staleMs: 60_000,
    retryMs: 5,
  });
  const elapsed = Date.now() - started;
  child.kill("SIGKILL");
  await once(child, "exit");

  if (result) releaseFileLock(result);
  assert.ok(elapsed < 3_000, `захват завис на ${elapsed}ms вместо дедлайна`);
});

// ─── one contender step at a time ──────────────────────────────────────────
// A race between two processes lands on a different branch of the acquisition every run.
// Here a hook on one node:fs call plays the other contender at an exact step, in process,
// so every branch runs on every run (syncBuiltinESMExports carries the hook to the
// named imports fs-atomic.ts uses).

const realOpenSync = fs.openSync;
const realReaddirSync = fs.readdirSync;

function withFsHook(install: () => void, run: () => void): void {
  install();
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

const quickLock = { timeoutMs: 40, staleMs: 60_000, retryMs: 5 };

test("a lock directory replaced right after mkdir is left to its new owner", () => {
  const path = join(workspace(), "store.json.lock");
  let swapped = false;
  withFsHook(
    () =>
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        if (!swapped && String(args[0]) === path && args[1] === "r") {
          swapped = true;
          fs.rmdirSync(path);
          fs.mkdirSync(path, { mode: 0o700 });
        }
        return realOpenSync(...args);
      }),
    () => {
      assert.equal(acquireFileLockSync(path, quickLock), null);
    },
  );
  assert.equal(swapped, true);
  assert.deepEqual(readdirSync(path), [], "the replacement is not touched");
});

test("a second owner entry beside ours withdraws ours and keeps theirs", () => {
  const path = join(workspace(), "store.json.lock");
  const foreign = `.owner-${randomUUID()}`;
  let planted = false;
  withFsHook(
    () =>
      mock.method(
        fs,
        "readdirSync",
        (...args: Parameters<typeof fs.readdirSync>) => {
          if (!planted && String(args[0]) === path) {
            planted = true;
            writeFileSync(join(path, foreign), "");
          }
          return realReaddirSync(...args);
        },
      ),
    () => {
      assert.equal(acquireFileLockSync(path, quickLock), null);
    },
  );
  assert.equal(planted, true);
  assert.deepEqual(readdirSync(path), [foreign]);
});

test("an owner entry that fails with a retryable error is retried and then held", () => {
  const path = join(workspace(), "store.json.lock");
  let failed = false;
  withFsHook(
    () =>
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        if (!failed && args[1] === "wx") {
          failed = true;
          throw Object.assign(new Error("EINVAL: open"), {
            code: "EINVAL",
            syscall: "open",
          });
        }
        return realOpenSync(...args);
      }),
    () => {
      const held = acquireFileLockSync(path, quickLock);
      assert.ok(held);
      assert.deepEqual(readdirSync(path), [`.owner-${held.token}`]);
      releaseFileLock(held);
    },
  );
  assert.equal(failed, true);
});

test("an owner entry that fails for another reason is thrown and leaves no lock", () => {
  const path = join(workspace(), "store.json.lock");
  withFsHook(
    () =>
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        if (args[1] === "wx")
          throw Object.assign(new Error("EACCES: open"), { code: "EACCES" });
        return realOpenSync(...args);
      }),
    () => {
      assert.throws(() => acquireFileLockSync(path, quickLock), {
        code: "EACCES",
      });
    },
  );
  assert.equal(existsSync(path), false);
});
