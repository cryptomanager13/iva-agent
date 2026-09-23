// Срок и остановка хода ночного роллапа.
//
// Зачем: на eve 0.27.13 резюм припаркованной сессии ПОСЛЕ рестарта сервера виснет молча
// (vercel/eve#1450) — `session.send()` отвечает 200, а `await response.result()` не резолвится никогда.
// Обычный try/catch такое не ловит: ошибки нет, ход просто не заканчивается, и ночной
// юнит висит до утра, не написав ни строчки в журнал. Гонка с таймером превращает молчание
// в честную ошибку, после которой вызывающий гасит ход на сервере.
//
// Таймер обязательно гасится в finally: живой setTimeout держит event loop и не даёт
// процессу (и тесту) завершиться после успешного хода.

import {
  DEFAULT_TIMEOUT_MS,
  JOB_STOP_AT_ENV,
  JOB_STOP_GRACE_MS,
} from "#lib/schedule-runner.ts";

interface TimeoutOptions {
  readonly timeoutMs?: number;
}

interface TurnTimeoutOptions {
  readonly timeoutMs: number;
  readonly label?: string;
}

interface RetryState {
  readonly cancelConfirmed: boolean;
  readonly sessionNotActive: boolean;
}

interface CancelSession<T = unknown> {
  cancel(options?: { tasks?: boolean; turnId?: string }): Promise<T>;
}

interface CancelResult {
  readonly status?: string;
}

interface TurnResult {
  readonly events?: readonly { readonly type?: string }[];
}

const MAX_TIMER_MS = 2 ** 31 - 1;

// Момент, когда работу сводки пора кончать (epoch ms). Срок один — срок запуска у раннера:
// раннер кладёт этот момент в окружение ребёнка (agent/lib/schedule-runner.ts). Ручной
// запуск мимо раннера получает тот же срок от своего старта. Кривое значение — ошибка:
// тихий дефолт снова развёл бы срок хода и потолок расписания.
export function resolveStopAt(raw: string | undefined, nowMs: number): number {
  if (raw === undefined || raw === "")
    return nowMs + DEFAULT_TIMEOUT_MS - JOB_STOP_GRACE_MS;
  const stopAt = Number(raw);
  // Node держит таймер в 32-битном знаковом диапазоне: дальше он молча схлопывается в 1 мс.
  if (!/^\d+$/u.test(raw) || stopAt - nowMs > MAX_TIMER_MS)
    throw new TypeError(
      `${JOB_STOP_AT_ENV}=${raw} is not an epoch time in milliseconds within ${MAX_TIMER_MS} ms from now`,
    );
  return stopAt;
}

export class RollupTurnTimeoutError extends Error {
  declare readonly code: "ROLLUP_TURN_TIMEOUT";
  declare readonly label: string;

  constructor(label: string, timeoutMs: number) {
    super(
      `rollup turn "${label}" timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
    this.name = "RollupTurnTimeoutError";
    this.code = "ROLLUP_TURN_TIMEOUT";
    this.label = label;
  }
}

// Отмена и её подтверждение вместе укладываются в срок остановки раннера с запасом на
// выход процесса: и после своего срока, и после SIGTERM ход гасится до SIGKILL.
const DEFAULT_CANCEL_TIMEOUT_MS = JOB_STOP_GRACE_MS / 3;

// Любой сетевой отказ send двусмысленен: сервер мог принять ход до обрыва ответа.
// Без отмены retry безопасен только для штатного 409 session_not_active от eve.
export function isSessionNotActiveError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly status?: unknown;
  };
  return candidate.status === 409 && candidate.code === "session_not_active";
}

export function canRetryFresh({
  cancelConfirmed,
  sessionNotActive,
}: RetryState): boolean {
  return sessionNotActive === true || cancelConfirmed === true;
}

// Остановка хода на сервере. Таймаут клиента и выход процесса ход не останавливают — он
// продолжает писать в vault уже без .memory.lock, — поэтому любой обрыв сначала гасит ход.
// `tasks: true`, как у стопа из чата (agent/lib/eve-cancel.ts): без него порождённая ходом
// задача живёт после отмены. Успешный HTTP-ответ cancel ещё не означает, что ход перестал
// писать. `accepted` только принимает сигнал отмены; безопасную границу подтверждает
// `turn.cancelled` в дочитанном результате. `no_active_turn` сам является серверным
// подтверждением, что писателя уже нет.
export async function cancelTurnAndConfirmQuietly(
  session: CancelSession<CancelResult>,
  turnResult: Promise<TurnResult> | undefined,
  { timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS }: TimeoutOptions = {},
): Promise<boolean> {
  try {
    const cancellation = await withTurnTimeout(
      () => session.cancel({ tasks: true }),
      { timeoutMs, label: "cancel" },
    );
    return await cancellationConfirmed(cancellation, turnResult, timeoutMs);
  } catch (error) {
    console.error(
      `rollup-turn: не удалось подтвердить отмену хода: ${String(error)}`,
    );
    return false;
  }
}

async function cancellationConfirmed(
  cancellation: CancelResult | undefined,
  turnResult: Promise<TurnResult> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (cancellation?.status === "no_active_turn") return true;
  if (cancellation?.status !== "accepted" || !turnResult) return false;
  const result = await withTurnTimeout(() => turnResult, {
    timeoutMs,
    label: "cancel-terminal",
  });
  return (
    result?.events?.some((event) => event?.type === "turn.cancelled") === true
  );
}

// Выполняет fn() и отклоняется RollupTurnTimeoutError, если тот не уложился в timeoutMs.
// Проигравшая сторона гонки сама не отменяется: вызывающий гасит ход на сервере
// (cancelTurnAndConfirmQuietly) до выхода и до любого повтора.
export async function withTurnTimeout<T>(
  fn: () => Promise<T>,
  { timeoutMs, label = "turn" }: TurnTimeoutOptions,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RollupTurnTimeoutError(label, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
