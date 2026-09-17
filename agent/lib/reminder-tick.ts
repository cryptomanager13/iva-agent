// Минутный тик диспетчера напоминаний: забрать созревшие строки таблицы и отдать каждую
// своему ребёнку scripts/reminders/fire.ts. Ход агента и отправка живут в
// scripts/: authored tree не может импортировать транспорт Telegram и клиента eve
// (scripts/authored-tree-guard.test.ts), поэтому тик спавнит скрипт по имени.
//
// Взятие строки — один атомарный переход pending → fired внутри fireDue: повторное
// срабатывание невозможно по построению, поэтому у тика нет ни аренды, ни повторов, ни
// ожидания ребёнка перед следующим тиком. Ребёнок только дописывает факт в строку; если он
// не запустился или умер, не сказав факта, тик пишет delivered=false с причиной по коду
// выхода — и на этом всё, второго захода у строки нет.
//
// Пульс тика — mtime файла data/reminders.tick: он обновляется после удачного взятия, и по
// нему `iva doctor` и remind list говорят, жив ли диспетчер.
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  ReminderStoreError,
  fireDue,
  list,
  recordDelivery,
  sweepFired,
  type Reminder,
} from "./reminder-store.ts";
import {
  runScheduledJob,
  type RunScheduledJobOptions,
  type RunScheduledJobResult,
} from "./schedule-runner.ts";

/** Строк за тик; остальное заберёт следующий тик. */
export const REMINDER_CLAIM_LIMIT = 5;
/** Тик старше этого — планировщик не жив. */
export const REMINDER_TICK_STALE_MS = 3 * 60_000;
/** Потолок ребёнка: ход агента останавливается на восьмой минуте, отправка — быстрее. */
export const REMINDER_FIRE_TIMEOUT_MS = 10 * 60_000;

export function tickPulseFile(dir: string = dataDir()): string {
  return join(dir, "reminders.tick");
}

/** Пульс: mtime — единственное, что важно; содержимое нужно человеку, читающему файл. */
export function touchTickPulse(nowMs: number): void {
  writeFileSync(tickPulseFile(), `${nowMs}\n`, { mode: 0o600 });
}

/**
 * Когда тик бился в последний раз; null — файла нет, то есть тик ещё не проходил.
 * Каталог данных - явный параметр для процессов, чей cwd не корень установки (doctor
 * из diagnose.sh): иначе пульс искался не там и доктор врал «ещё не тикал» (14.09.2026).
 */
export function readTickPulse(dir?: string): number | null {
  try {
    return statSync(tickPulseFile(dir)).mtimeMs;
  } catch {
    return null;
  }
}

export interface ReminderTickOptions {
  readonly nowMs?: number;
  readonly limit?: number;
  readonly root?: string;
  readonly nodeBin?: string;
  readonly runJob?: typeof runScheduledJob;
  readonly log?: (...args: unknown[]) => void;
}

export interface ReminderTickResult {
  readonly claimed: number;
  readonly spawned: number;
  readonly filled: number;
  readonly swept: number;
  readonly error?: string;
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Чем закончился ребёнок, по полям результата runScheduledJob. */
function fireFailure(result: RunScheduledJobResult): string {
  if (result.error !== undefined)
    return `fire process failed to start: ${message(result.error)}`;
  if (result.signal) return `fire process killed by ${result.signal}`;
  return `fire process exited ${result.code ?? "unknown"}`;
}

/**
 * Один тик. Никогда не бросает наружу: это обработчик расписания, как и runScheduledJob —
 * сбой самого тика не должен ронять ход планировщика.
 */
export async function runReminderTick(
  options: ReminderTickOptions = {},
): Promise<ReminderTickResult> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? REMINDER_CLAIM_LIMIT;
  const root = options.root ?? process.cwd();
  const nodeBin = options.nodeBin ?? process.execPath;
  const runJob = options.runJob ?? runScheduledJob;
  const log =
    options.log ??
    ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));

  let rows: Reminder[];
  try {
    rows = await fireDue(nowMs, limit);
  } catch (error) {
    const failure = message(error);
    log(`reminders: tick failed: ${failure}`);
    return { claimed: 0, spawned: 0, filled: 0, swept: 0, error: failure };
  }

  // Пульс — после удачного взятия: битая таблица значит, что сроки не разносятся, и
  // «диспетчер жив» было бы враньём.
  touchTickPulse(nowMs);

  let swept = 0;
  try {
    swept = await sweepFired(nowMs);
  } catch (error) {
    log(`reminders: sweep failed: ${message(error)}`);
  }

  if (rows.length === 0) return { claimed: 0, spawned: 0, filled: 0, swept };

  log(
    `reminders: tick claimed ${rows.length}: ${rows.map((row) => row.id).join(", ")}`,
  );

  let spawned = 0;
  let filled = 0;

  const fireRow = async (row: Reminder): Promise<void> => {
    const jobOptions: RunScheduledJobOptions = {
      name: `reminder-${row.id}`,
      argv: ["scripts/reminders/fire.ts", row.id],
      root,
      nodeBin,
      timeoutMs: REMINDER_FIRE_TIMEOUT_MS,
      log,
    };
    // Настоящий runScheduledJob никогда не бросает; двойник в тесте — может, причём и
    // синхронно. Любой бросок значит одно: ребёнок не сказал факта.
    let result: RunScheduledJobResult;
    try {
      result = await runJob(jobOptions);
    } catch (error) {
      result = { skipped: false, ok: false, code: null, signal: null, error };
    }
    const after = (await list()).find((candidate) => candidate.id === row.id);
    if (after === undefined || after.delivered !== null) {
      spawned += 1;
      log(
        `reminders: ${row.id} fired (delivered=${after?.delivered ?? "row gone"})`,
      );
      return;
    }
    // Ребёнок отработал и вышел 0, а факта нет: текст мог уйти, а запись не состояться
    // (лок таблицы занят) — сказать «не дошло» про такую строку нельзя. Факт остаётся
    // невидимым, причина названа явно, и доктор говорит о ней иначе, чем о провале.
    if (result.ok && !result.skipped) {
      try {
        await recordDelivery(
          row.id,
          {
            firedAt: row.firedAt,
            delivered: null,
            error: "delivery fact not recorded",
          },
          { log },
        );
      } catch (error) {
        if (error instanceof ReminderStoreError) {
          log(`reminders: ${row.id} outcome not recorded: ${message(error)}`);
          return;
        }
        throw error;
      }
      filled += 1;
      log(`reminders: ${row.id} delivery fact not recorded`);
      return;
    }
    // Ребёнок не сказал факта: причина — по коду выхода. Больше за эту строку не берёмся.
    const failure = fireFailure(result);
    try {
      await recordDelivery(
        row.id,
        { firedAt: row.firedAt, delivered: false, error: failure },
        { log },
      );
    } catch (error) {
      if (error instanceof ReminderStoreError) {
        log(`reminders: ${row.id} outcome not recorded: ${message(error)}`);
        return;
      }
      throw error;
    }
    filled += 1;
    log(`reminders: ${row.id} not delivered: ${failure}`);
  };

  const outcomes = await Promise.allSettled(rows.map((row) => fireRow(row)));
  outcomes.forEach((outcome, index) => {
    if (outcome.status !== "rejected") return;
    filled += 1;
    log(
      `reminders: ${rows[index]?.id} tick handler threw: ${message(outcome.reason)}`,
    );
  });

  return { claimed: rows.length, spawned, filled, swept };
}
