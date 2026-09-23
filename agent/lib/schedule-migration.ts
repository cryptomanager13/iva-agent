// One-shot, idempotent migration from the old systemd memory-rollup timers to the
// in-process eve schedules (agent/schedules/memory-*.ts). Called fire-and-forget from
// agent/instrumentation.ts on every server start, and living in the authored tree with the
// schedules it migrates onto. The retired unit NAMES are systemd's business as much as the
// agent's: `iva doctor` sweeps the same eight from a tree whose agent/ may be missing, so
// scripts/lib/legacy-memory-units.ts carries its own copy and the two are pinned together
// in this module's test. Two INDEPENDENT jobs — independent
// enough that only one of them needs systemd at all:
//
//   1. tear down the 8 retired iva-memory-{daily,weekly,monthly,yearly}.{service,timer}
//      units, by exact name only — self-host users may have their own unrelated timers
//      (e.g. xfeed-daily.timer) sitting in the same directory, never touch those. Skipped
//      entirely wherever there is no user systemd at all (containers, this repo's own
//      `npm run replica` sandbox, CI) — there is nothing to tear down there.
//   2. catch up a period whose last systemd-timer success predates its most recent
//      scheduled point, bounded by a grace window so a months-old miss doesn't fire late.
//      Persistent=true is gone with the timers, so this replaces it — and runs on every
//      boot REGARDLESS of systemd availability, since a missed rollup is worth catching
//      up whether or not this host ever had systemd units to retire in the first place.
//
// Must NEVER throw: a broken systemctl or a corrupt status file must not stop the server
// from starting.
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { jobFactsFile } from "./job-facts.ts";

// WHEN each period fires — time of day AND day constraint — comes from the schedule table
// the eve schedules themselves read; this module restates none of it. Table and runner are
// siblings in the authored tree, so both are plain static imports.
import { SCHEDULE_CRON, parseCron } from "./schedule-table.ts";
import type { ScheduleCron, ScheduleName } from "./schedule-table.ts";
import {
  readStatus,
  runScheduledJob,
  withStatusLock,
  writeStatusAtomic,
} from "./schedule-runner.ts";
import { addDaysToDate, zonedParts, zonedToUtcMs } from "./zoned-time.ts";
import { memoryRollupJob } from "./schedule-paths.ts";

type Period = "daily" | "weekly" | "monthly" | "yearly";

interface ExecResult {
  readonly code: number;
  readonly out?: string;
  readonly err?: string;
  readonly error?: unknown;
}

type ExecImplementation = (args: readonly string[]) => ExecResult;

interface MigrationStatusEntry {
  readonly lastSuccessAt?: number;
  readonly seededAt?: number;
  readonly [key: string]: unknown;
}

type MigrationStatus = Record<string, MigrationStatusEntry>;

interface DuePeriod {
  readonly period: Period;
  readonly dueAt: number;
  readonly effectiveBaseline: number | undefined;
}

type MigrationDecision =
  | { readonly action: "defer" }
  | {
      readonly action: "run";
      readonly due: readonly DuePeriod[];
      readonly freshlySeeded: readonly Period[];
    };

export interface RunScheduleMigrationOptions {
  readonly homedir?: string;
  readonly execImpl?: ExecImplementation;
  readonly statusPath?: string;
  readonly tz?: string;
  readonly log?: (...args: unknown[]) => void;
  readonly now?: () => number;
  readonly root?: string;
  readonly nodeBin?: string;
  readonly runJob?: (period: Period) => Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return (error as { readonly message: string }).message;
}

function errorCode(error: unknown): unknown {
  return (error as { readonly code?: unknown } | null | undefined)?.code;
}

export const LEGACY_MEMORY_UNITS: readonly string[] = [
  "iva-memory-daily.service",
  "iva-memory-daily.timer",
  "iva-memory-weekly.service",
  "iva-memory-weekly.timer",
  "iva-memory-monthly.service",
  "iva-memory-monthly.timer",
  "iva-memory-yearly.service",
  "iva-memory-yearly.timer",
];

// How late a missed run may still be caught up, per period — a catch-up policy of this
// module alone, not schedule metadata.
const PERIOD_GRACE_MS: Record<Period, number> = {
  daily: 20 * 60 * 60 * 1000,
  weekly: 3 * 24 * 60 * 60 * 1000,
  monthly: 7 * 24 * 60 * 60 * 1000,
  yearly: 14 * 24 * 60 * 60 * 1000,
};
const PERIODS = Object.keys(PERIOD_GRACE_MS) as Period[];

// The status-file key a real run is recorded under — must match the `name` each
// agent/schedules/memory-*.ts passes to runScheduledJob, not the bare period.
function statusKey(period: Period): ScheduleName {
  return `memory-${period}`;
}

function defaultExecImpl(args: readonly string[]): ExecResult {
  const r = spawnSync("systemctl", args, { encoding: "utf8" });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    error: r.error,
  };
}

// Does a plain Y-M-D calendar date satisfy the cron's date fields? The weekday does not
// depend on tz once the calendar date itself is fixed. parseCron() refuses a cron that
// constrains day-of-month and day-of-week at once, so there is no OR case to decide here.
function matchesDate(
  cron: ScheduleCron,
  { y, m, d }: { y: number; m: number; d: number },
): boolean {
  if (cron.month !== null && cron.month !== m) return false;
  if (cron.dayOfMonth !== null && cron.dayOfMonth !== d) return false;
  if (cron.dayOfWeek === null) return true;
  return cron.dayOfWeek === new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
}

// Returns the most recent scheduled UTC epoch ms for a cron, at or before `nowMs`: walk
// back from today's local calendar date to the most recent date the cron matches, then
// place its hour:minute in `tz`. Every field of the answer comes from the table, so a
// cadence change there moves the catch-up point with it.
function lastDueMs(cron: ScheduleCron, nowMs: number, tz: string): number {
  const today = zonedParts(nowMs, tz);
  let date = { y: today.y, m: today.m, d: today.d };
  // Two years of days: more than the widest cadence in the table (yearly) plus a leap day.
  for (let back = 0; back <= 732; back++) {
    if (matchesDate(cron, date)) {
      const candidate = zonedToUtcMs(
        date.y,
        date.m,
        date.d,
        cron.hour,
        cron.minute,
        tz,
      );
      if (candidate <= nowMs) return candidate;
    }
    date = addDaysToDate(date.y, date.m, date.d, -1);
  }
  throw new RangeError(
    `no date in the last two years matches month ${cron.month}, day ${cron.dayOfMonth}, weekday ${cron.dayOfWeek}`,
  );
}

// ── legacy unit teardown ─────────────────────────────────────────────────
function removeLegacyUnits({
  homedir,
  execImpl,
  log,
}: Required<
  Pick<RunScheduleMigrationOptions, "homedir" | "execImpl" | "log">
>): void {
  const unitDir = join(homedir, ".config/systemd/user");
  let touchedAny = false;
  for (const unit of LEGACY_MEMORY_UNITS) {
    const path = join(unitDir, unit);
    if (!existsSync(path)) continue;
    touchedAny = true;
    let disabled = false;
    try {
      const result = execImpl(["--user", "disable", "--now", unit]);
      if (result.code !== 0) {
        log(
          `schedule-migration: disable --now ${unit} failed (best-effort): ${result.err || result.out}`,
        );
      } else {
        disabled = true;
      }
    } catch (error) {
      log(
        `schedule-migration: disable --now ${unit} threw (best-effort): ${errorMessage(error)}`,
      );
    }
    // Only remove the file once systemd has actually let go of the unit. Deleting it
    // after a failed disable would leave a still-enabled/active unit with no file behind
    // — invisible to a human, but still running (or still armed to run again). Leaving
    // the file in place means this boot's cleanup is simply retried on the next one,
    // same as a partial systemctl failure anywhere else in this function.
    if (!disabled) {
      log(
        `schedule-migration: leaving ${unit} in place — disable failed, the next boot will retry`,
      );
      continue;
    }
    try {
      rmSync(path, { force: true });
    } catch (error) {
      log(
        `schedule-migration: removing ${unit} failed (best-effort): ${errorMessage(error)}`,
      );
    }
  }
  if (touchedAny) {
    try {
      const reload = execImpl(["--user", "daemon-reload"]);
      if (reload.code !== 0)
        log(
          `schedule-migration: daemon-reload failed (best-effort): ${reload.err || reload.out}`,
        );
    } catch (error) {
      log(
        `schedule-migration: daemon-reload threw (best-effort): ${errorMessage(error)}`,
      );
    }
    try {
      const reset = execImpl(["--user", "reset-failed"]);
      if (reset.code !== 0)
        log(
          `schedule-migration: reset-failed failed (best-effort): ${reset.err || reset.out}`,
        );
    } catch (error) {
      log(
        `schedule-migration: reset-failed threw (best-effort): ${errorMessage(error)}`,
      );
    }
  }
}

export async function runScheduleMigration({
  homedir,
  execImpl = defaultExecImpl,
  statusPath,
  tz = "UTC",
  log = () => {},
  now = () => Date.now(),
  root,
  nodeBin = process.execPath,
  runJob,
}: RunScheduleMigrationOptions = {}): Promise<void> {
  try {
    if (!statusPath) return;

    const runPeriod =
      runJob ??
      ((period: Period) =>
        runScheduledJob({
          // Задание сводки описано в одном месте; догон подставляет свои пути.
          ...memoryRollupJob(period),
          root,
          nodeBin,
          lockPath: root ? join(root, ".memory.lock") : undefined,
          statusPath,
          factsPath: jobFactsFile(dirname(statusPath)),
          log,
        }));

    // Per-key seed, the seed write, AND the due-check all happen inside the
    // SAME single lock acquisition runScheduledJob's own admission check uses — never
    // decided from a status snapshot read outside any critical section. Two things this
    // closes: (1) a real run's own read-modify-write (recording inProgressSince/
    // lastStartedAt) racing the seed write and one silently clobbering the other; (2) the
    // due-or-not decision for each period being made from a stale snapshot that could
    // already be out of date by the time it's used. If the lock can't be acquired at
    // all, this whole pass is deferred rather than deciding anything from an unlocked
    // read — the next boot (or, for a period a Nitro tick fires in the meantime, that
    // tick itself) retries cleanly.
    const decision = await withStatusLock<MigrationDecision>(
      statusPath,
      (acquired) => {
        if (!acquired) {
          log(
            "schedule-migration: could not acquire the status lock in time — deferring this pass (retried on the next boot)",
          );
          return { action: "defer" };
        }
        let current: MigrationStatus;
        try {
          current = readStatus(statusPath);
        } catch (error) {
          // Seeding over a status we could not read would tell every period "you never
          // ran" and fire a catch-up burst off it. Defer the pass like the lock-less
          // path above.
          log(
            `schedule-migration: deferring this pass — ${(error as Error).message} (retried on the next boot)`,
          );
          return { action: "defer" };
        }
        const nowMs = now();
        const seeded: MigrationStatus = { ...current };
        const freshlySeeded = new Set<Period>();
        for (const period of PERIODS) {
          const key = statusKey(period);
          const entry = current[key];
          if (
            typeof entry?.lastSuccessAt !== "number" &&
            typeof entry?.seededAt !== "number"
          ) {
            seeded[key] = { ...entry, seededAt: nowMs };
            freshlySeeded.add(period);
          }
        }
        if (freshlySeeded.size > 0) writeStatusAtomic(statusPath, seeded);

        const due: DuePeriod[] = [];
        for (const period of PERIODS) {
          if (freshlySeeded.has(period)) continue;
          const graceMs = PERIOD_GRACE_MS[period];
          const dueAt = lastDueMs(
            parseCron(SCHEDULE_CRON[statusKey(period)]),
            nowMs,
            tz,
          );
          const entry = seeded[statusKey(period)];
          // A real success always wins; otherwise fall back to the seeded baseline (if
          // any) so a freshly-seeded period doesn't immediately look "due" the moment
          // it's due relative to real time — same suppression the old
          // lastSuccessAt-as-seed did.
          const recorded =
            typeof entry?.lastSuccessAt === "number"
              ? entry.lastSuccessAt
              : entry?.seededAt;
          const effectiveBaseline = recorded;
          const alreadyCaughtUp =
            effectiveBaseline !== undefined && effectiveBaseline >= dueAt;
          const withinGrace = nowMs - dueAt <= graceMs;
          if (!alreadyCaughtUp && withinGrace)
            due.push({ period, dueAt, effectiveBaseline });
        }
        return { action: "run", due, freshlySeeded: [...freshlySeeded] };
      },
    );

    if (decision.action === "defer") return;

    // The seed transaction must commit before the retired units are disabled. A crash
    // before this point leaves the old persistent timers able to cover the night; a
    // crash after it has a durable in-process catch-up baseline.
    if (homedir && existsSync(join(homedir, ".config/systemd/user"))) {
      let probe: ExecResult;
      try {
        probe = execImpl(["--version"]);
      } catch (error) {
        probe = { code: 127, error };
      }
      if (errorCode(probe.error) !== "ENOENT") {
        removeLegacyUnits({ homedir, execImpl, log });
      }
    }

    if (decision.freshlySeeded.length > 0) {
      log(
        `schedule-migration: seeded catch-up baseline for ${decision.freshlySeeded.join(", ")} (storm protection)`,
      );
    }

    // The actual catch-up run (and ITS OWN reservation, under its own fresh lock
    // acquisition inside runScheduledJob) happens outside this critical section — it can
    // take up to the job's full timeoutMs, and holding the status lock for that entire
    // duration would block every other schedule's admission check in the meantime.
    for (const { period, dueAt, effectiveBaseline } of decision.due) {
      const lastSuccess =
        typeof effectiveBaseline === "number" &&
        Number.isFinite(effectiveBaseline)
          ? new Date(effectiveBaseline).toISOString()
          : "never";
      log(
        `schedule-migration: catching up ${period} (due ${new Date(dueAt).toISOString()}, last success ${lastSuccess})`,
      );
      try {
        await runPeriod(period);
      } catch (error) {
        log(
          `schedule-migration: catch-up run for ${period} failed: ${errorMessage(error)}`,
        );
      }
    }
  } catch (error) {
    try {
      log(`schedule-migration: unexpected failure: ${errorMessage(error)}`);
    } catch {
      // logging must never be able to throw out of this function
    }
  }
}
