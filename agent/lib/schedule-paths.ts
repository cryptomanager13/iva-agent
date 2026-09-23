// Shared path resolution for agent/schedules/*.ts — root/dataDir/statusPath/lockPath were
// duplicated identically across all 5 schedule files; one place to change if the status
// filename, lock filename, or ASSISTANT_DATA_DIR resolution rule ever changes.
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { jobFactsFile } from "./job-facts.ts";
import { JOB_STOP_GRACE_MS } from "./schedule-runner.ts";

export interface SchedulePaths {
  readonly root: string;
  readonly dataDir: string;
  readonly statusPath: string;
  readonly memoryLockPath: string;
  /** Таблица фактов расписаний (T20 п.1) — история запусков для агента и доктора. */
  readonly factsPath: string;
}

export function resolvePaths(): SchedulePaths {
  const root = process.cwd();
  const resolvedDataDir = dataDir();
  return {
    root,
    dataDir: resolvedDataDir,
    statusPath: join(resolvedDataDir, "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
    factsPath: jobFactsFile(resolvedDataDir),
  };
}

export type MemoryPeriod = "daily" | "weekly" | "monthly" | "yearly";

// Same command shape every memory-*.ts schedule spawns: `flock -w 3900 .memory.lock node
// --env-file-if-exists=.env scripts/memory/rollup.ts <period>` — see agent/lib/schedule-runner.ts.
export function memoryRollupJob(period: MemoryPeriod) {
  const { root, statusPath, memoryLockPath, factsPath } = resolvePaths();
  return {
    name: `memory-${period}`,
    argv: ["scripts/memory/rollup.ts", period],
    root,
    nodeBin: process.execPath,
    lockPath: memoryLockPath,
    statusPath,
    factsPath,
    killGraceMs: JOB_STOP_GRACE_MS,
  };
}
