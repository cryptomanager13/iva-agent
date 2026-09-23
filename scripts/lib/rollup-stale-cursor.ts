// Обход vercel/eve#2461, всё ещё нужный в eve 0.51.1: на резюмнутой сессии клиент
// читает поток с сохранённого streamIndex и останавливается на первой границе хода, не сверяя её с только что
// отправленным сообщением. Отставший курсор превращает result() в чтение старого хода:
// ночной отчёт уходит пятидневной давности, а падение реального хода не всплывает.
//
// Два слоя, оба временные: дочитать stream({follow:false}) до хвоста перед send и
// отказаться от результата, в событиях которого нет нашего message.received. Промпт
// несёт одноразовый nonce, чтобы повтор той же даты не принял чужой ход; нижняя
// граница времени — момент send, без запасной минуты. Снять оба слоя, когда eve
// свяжет result() с отправленным ходом (vercel/eve#2461).

import { type ClientSession } from "eve/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface PersistedRollupSession {
  readonly sessionId: string;
  readonly createdAt: number;
}

export function parsePersistedRollupSession(
  value: unknown,
): PersistedRollupSession | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "createdAt" || keys[1] !== "sessionId")
    return null;
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    value.sessionId !== value.sessionId.trim() ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  )
    return null;
  return { sessionId: value.sessionId, createdAt: value.createdAt };
}

export function attachRollupNonce(prompt: string, nonce: string): string {
  return `${prompt}\n<!-- rollup-nonce ${nonce} -->`;
}

export function sentNotBeforeIso(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function isOwnTurnResult(
  events: readonly unknown[],
  {
    prompt,
    sentNotBefore,
  }: {
    readonly prompt: string;
    readonly sentNotBefore: string;
  },
): boolean {
  const sentAt = Date.parse(sentNotBefore);
  if (!Number.isFinite(sentAt)) return false;
  return events.some((event) => {
    if (!isRecord(event) || event.type !== "message.received") return false;
    if (!isRecord(event.data) || !isRecord(event.meta)) return false;
    const receivedAt =
      typeof event.meta.at === "string" ? Date.parse(event.meta.at) : NaN;
    return (
      event.data.message === prompt &&
      Number.isFinite(receivedAt) &&
      receivedAt >= sentAt
    );
  });
}

export async function drainStreamToTail(
  session: Pick<ClientSession, "stream">,
  onError: ((error: Error) => void) | undefined,
  timeoutMs: number,
): Promise<void> {
  // Зависший bounded-read иначе остановит ночь до guardedTurn(). AbortSignal —
  // контракт stream() у eve: for-await его достаточно. По таймауту abort сигнала
  // отклоняет pending next(); return() не вызываем — без своей границы он сам
  // может зависнуть.
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => {
    controller.abort(new Error("pre-send stream drain timed out"));
  }, timeoutMs);
  try {
    for await (const event of session.stream({
      follow: false,
      signal,
    })) {
      void event;
    }
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  } finally {
    clearTimeout(timer);
  }
}

/** Drain the saved cursor before an action that starts the next Turn. */
export async function drainStreamBefore<T>(
  session: Pick<ClientSession, "stream">,
  action: () => Promise<T>,
  onError: ((error: Error) => void) | undefined,
  timeoutMs: number,
): Promise<T> {
  let drainError: Error | undefined;
  try {
    await drainStreamToTail(
      session,
      (error) => {
        drainError = error;
        onError?.(error);
      },
      timeoutMs,
    );
  } catch (error) {
    throw drainError ?? error;
  }
  if (drainError) throw drainError;
  return await action();
}
