/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойство редуктора событий хода: любая мешанина событий (включая мусорные типы и
// неожидаемые данные) даёт статус последней границы, признак внешней отмены (`turn.cancelled`)
// и последний текст, который нёс `data.message` (его несут `message.completed` и
// `session.failed` — причина провала печатается тем же полем), и никогда не бросает.
// Якоря контракта — в reminder-turn.test.ts.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { reduceTurnEvents } from "./reminder-turn.ts";

const EVENT_TYPES = [
  "step.started",
  "message.appended",
  "message.completed",
  "session.waiting",
  "session.completed",
  "session.failed",
  "turn.failed",
  "turn.cancelled",
  "zzz.unknown",
] as const;

const boundaryStatus = {
  "session.waiting": "waiting",
  "session.completed": "completed",
  "session.failed": "failed",
} as const;

const event = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  data: fc.oneof(
    fc.constant(undefined),
    fc.record({ message: fc.oneof(fc.string(), fc.constant(null)) }),
    fc.anything(),
  ),
});

function textOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const text = (data as { readonly message?: unknown }).message;
  return typeof text === "string" ? text : undefined;
}

test("reduceTurnEvents never throws and reports the last boundary", () => {
  fc.assert(
    fc.property(fc.array(event, { maxLength: 30 }), (events) => {
      const result = reduceTurnEvents(events);

      let expectedStatus: string | undefined;
      let expectedMessage: string | undefined;
      let expectedFailure: string | undefined;
      let expectedCancelled = false;
      for (const item of events) {
        const text = textOf(item.data);
        if (item.type === "turn.cancelled") expectedCancelled = true;
        if (item.type === "message.completed" && text !== undefined)
          expectedMessage = text;
        if (item.type === "session.failed" && text !== undefined)
          expectedMessage = text;
        if (item.type === "turn.failed" && text !== undefined)
          expectedFailure = text;
        const status = boundaryStatus[item.type as keyof typeof boundaryStatus];
        if (status !== undefined) expectedStatus = status;
      }

      assert.ok(
        ["completed", "failed", "waiting", undefined].includes(result.status),
        `статус вне контракта: ${String(result.status)}`,
      );
      assert.equal(result.status, expectedStatus);
      assert.equal(result.message, expectedMessage);
      assert.equal(result.failure, expectedFailure);
      assert.equal(result.cancelled, expectedCancelled);
    }),
    { numRuns: 200 },
  );
});
