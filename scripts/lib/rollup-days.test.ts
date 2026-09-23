/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Отметки прогресса в сыром дне и выбор пропущенных дат. Вход — произвольный транскрипт
// с произвольными отметками и произвольное окно состояний дней, поэтому свойства.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: fast-check печатает `{ seed: …, path: "…" }`; подставь их
// вторым аргументом fc.assert(prop, { seed, path }) — прогон повторится байт в байт.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  dayProgress,
  isDayDone,
  LOOKBACK_DAYS,
  MAX_DAYS_PER_RUN,
  pendingDays,
  shiftDate,
  type DayState,
} from "./rollup-days.ts";

const RUNS = { numRuns: 300 };

const hhmm = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(
    ([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  );

// Запись транскрипта: заголовок и текст пользователя. Текст — любой, кроме строки,
// которая сама выглядит как отметка: транскрипт её не несёт, отметки пишет скилл.
const entry = fc
  .tuple(hhmm, fc.string({ maxLength: 40 }))
  .map(([at, text]) => `## ${at} [text]\n\n${text.replaceAll("<!--", "")}\n`);

const partMarker = (at: string): string =>
  `<!-- processed-through: ${at} -->\n`;
const DONE = "<!-- processed: 2026-09-22T04:10 -->\n";

test("the last part marker is where the day resumes; only the end marker makes it done", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.array(entry, { maxLength: 4 }), fc.option(hhmm))),
      fc.boolean(),
      (parts, finished) => {
        let raw = "";
        let last: string | null = null;
        for (const [entries, marker] of parts) {
          raw += entries.join("\n");
          if (marker !== null) {
            raw += partMarker(marker);
            last = marker;
          }
        }
        if (finished) raw += DONE;
        assert.deepEqual(dayProgress(raw), { done: finished, through: last });
      },
    ),
    RUNS,
  );
});

test("a day processed before part markers existed is done by its summary alone", () => {
  const raw = "## 10:00 [text]\n\nпривет\n";
  assert.equal(isDayDone({ raw, summaryExists: true }), true);
  assert.equal(isDayDone({ raw, summaryExists: false }), false);
  // Сводка рядом с отметкой части — сводка незаконченного дня.
  assert.equal(
    isDayDone({ raw: raw + partMarker("10:00"), summaryExists: true }),
    false,
  );
  assert.equal(isDayDone({ raw: raw + DONE, summaryExists: false }), true);
});

const YESTERDAY = "2026-09-22";
const state: fc.Arbitrary<DayState> = fc.record({
  raw: fc.constantFrom(
    null,
    "## 09:00 [text]\n\nдень\n",
    `## 09:00 [text]\n\nдень\n${partMarker("09:00")}`,
    `## 09:00 [text]\n\nдень\n${DONE}`,
  ),
  summaryExists: fc.boolean(),
});

test("missed days come oldest first, only undone, under the cap, inside the window", () => {
  fc.assert(
    fc.property(fc.array(state, { minLength: 10, maxLength: 10 }), (days) => {
      // Индекс 0 — вчера, дальше в прошлое; окно шире LOOKBACK_DAYS, чтобы проверить край.
      const byDate = new Map(
        days.map((s, back) => [shiftDate(YESTERDAY, -back), s]),
      );
      const read = (date: string): DayState => {
        const found = byDate.get(date);
        assert.ok(found, `read outside the generated window: ${date}`);
        return found;
      };
      const expected = [...byDate.entries()]
        .filter(([date]) => date > shiftDate(YESTERDAY, -LOOKBACK_DAYS))
        .filter(([, s]) => !isDayDone(s))
        .filter(([date, s]) => s.raw !== null || date === YESTERDAY)
        .map(([date]) => date)
        .sort()
        .slice(0, MAX_DAYS_PER_RUN);
      assert.deepEqual(pendingDays(YESTERDAY, read), expected);
    }),
    RUNS,
  );
});

test("a failed night stays pending the next night instead of reading as done", () => {
  const raw = "## 23:40 [voice]\n\nдлинный день\n";
  const days = new Map<string, DayState>([
    ["2026-09-21", { raw: raw + partMarker("12:05"), summaryExists: true }],
    ["2026-09-22", { raw, summaryExists: false }],
  ]);
  const read = (date: string): DayState =>
    days.get(date) ?? { raw: null, summaryExists: true };
  assert.deepEqual(pendingDays("2026-09-22", read), [
    "2026-09-21",
    "2026-09-22",
  ]);
});
