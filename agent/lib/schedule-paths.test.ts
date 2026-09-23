import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const MODULE_URL = new URL("./schedule-paths.ts", import.meta.url).href;
const PROBE_PROGRAM = `
  const { resolvePaths, memoryRollupJob } =
    await import(process.env.SCHEDULE_PATHS_URL);
  const period = process.env.SCHEDULE_PATHS_PERIOD;
  const result = period ? memoryRollupJob(period) : resolvePaths();
  process.stdout.write(JSON.stringify(result));
`;

type MemoryPeriod = "daily" | "weekly" | "monthly" | "yearly";

function temporaryDirectory(t: TestContext): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "iva-schedule-paths-")),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function probe(options: {
  readonly cwd: string;
  readonly dataDir?: string;
  readonly period?: MemoryPeriod;
}): unknown {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCHEDULE_PATHS_URL: MODULE_URL,
  };
  delete env.ASSISTANT_DATA_DIR;
  delete env.SCHEDULE_PATHS_PERIOD;
  if (options.dataDir !== undefined) {
    env.ASSISTANT_DATA_DIR = options.dataDir;
  }
  if (options.period !== undefined) {
    env.SCHEDULE_PATHS_PERIOD = options.period;
  }

  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", PROBE_PROGRAM],
    { cwd: options.cwd, env, encoding: "utf8" },
  );
  return JSON.parse(stdout) as unknown;
}

await test("resolvePaths defaults data paths under the current working directory", (t) => {
  const root = temporaryDirectory(t);

  assert.deepEqual(probe({ cwd: root }), {
    root,
    dataDir: join(root, "data"),
    statusPath: join(root, "data", "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
    factsPath: join(root, "data", "jobs.json"),
  });
});

await test("resolvePaths resolves a relative ASSISTANT_DATA_DIR from the root", (t) => {
  const root = temporaryDirectory(t);

  assert.deepEqual(probe({ cwd: root, dataDir: "runtime/state" }), {
    root,
    dataDir: join(root, "runtime/state"),
    statusPath: join(root, "runtime/state", "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
    factsPath: join(root, "runtime/state", "jobs.json"),
  });
});

await test("resolvePaths preserves an absolute data directory without moving the lock", (t) => {
  const root = temporaryDirectory(t);
  const dataDir = temporaryDirectory(t);

  assert.deepEqual(probe({ cwd: root, dataDir }), {
    root,
    dataDir,
    statusPath: join(dataDir, "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
    factsPath: join(dataDir, "jobs.json"),
  });
});

await test("memoryRollupJob returns the exact command contract for every period", (t) => {
  const root = temporaryDirectory(t);
  const periods: readonly MemoryPeriod[] = [
    "daily",
    "weekly",
    "monthly",
    "yearly",
  ];

  for (const period of periods) {
    assert.deepEqual(probe({ cwd: root, dataDir: "schedule-data", period }), {
      name: `memory-${period}`,
      argv: ["scripts/memory/rollup.ts", period],
      root,
      nodeBin: process.execPath,
      lockPath: join(root, ".memory.lock"),
      statusPath: join(root, "schedule-data", "rollup-status.json"),
      factsPath: join(root, "schedule-data", "jobs.json"),
      // Срок остановки сводки: отмена хода и её подтверждение успевают до SIGKILL.
      killGraceMs: 90_000,
    });
  }
});
