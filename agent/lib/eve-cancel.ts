import type { AttachSessionFn, CancelTurnResult } from "eve/channels";

/**
 * Единственное место КАНАЛЬНОЙ отмены: отмены хода, пришедшей снаружи по
 * sessionId (кнопка ⏹ Стоп и /stop). Маршрут, статус хода и кнопка про способ
 * отмены не знают.
 *
 * `attachSession` приходит из RouteHandlerArgs, поэтому вызывающий обязан быть
 * роутом канала: событийные обработчики этот helper не получают.
 *
 * Второй, НЕ канальный путь отмены в проекте — `scripts/lib/rollup-turn.ts`
 * (`cancelTurnAndConfirmQuietly`): ночной роллап держит client-сессию eve и гасит
 * свой ход через `session.cancel({ tasks: true })` — с задачами, как здесь. Это другой
 * API и другой владелец сессии, сюда он не сводится; при апгрейде eve его надо
 * мигрировать отдельно.
 */
export interface EveCancelRequest {
  /** Точный идентификатор сессии, записанный при старте хода. */
  readonly sessionId: string;
  /** Гард от опоздавшего нажатия: несовпавший turnId eve глотает как no-op. */
  readonly turnId?: string;
}

/** Оба статуса — успех: `accepted` и `no_active_turn` (отменять уже нечего). */
export function cancelEveTurn(
  attachSession: AttachSessionFn,
  { sessionId, turnId }: EveCancelRequest,
): Promise<CancelTurnResult> {
  return attachSession(sessionId).cancel({
    // Гасим не только сам ход, но и задачи, которые он успел породить: без `tasks`
    // осиротевшая задача сессии продолжает работать после «Стопа» и писать в vault.
    tasks: true,
    ...(turnId === undefined ? {} : { turnId }),
  });
}
