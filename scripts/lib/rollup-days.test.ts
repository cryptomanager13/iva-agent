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
  droppedDay,
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

const partMarker = (at: string): string =>
  `<!-- processed-through: ${at} -->\n`;
const DONE = "<!-- processed: 2026-09-22T04:10 -->\n";

// Запись транскрипта: заголовок и произвольный текст. Текст может цитировать отметку
// (Ива объясняет формат) — цитата внутри записи не отметка.
const entry = fc
  .tuple(
    hhmm,
    fc.string({ maxLength: 40 }),
    fc.option(fc.constantFrom(DONE, partMarker("23:59"))),
    fc.string({ minLength: 1, maxLength: 20 }).map((t) => `${t.trim()}x`),
  )
  .map(
    ([at, text, quoted, after]) =>
      `## ${at} [iva]\n\n${text}\n${quoted ?? ""}${after}\n`,
  );

test("only the trailing marks count: the last part mark resumes, the processed mark ends the day", () => {
  fc.assert(
    fc.property(
      fc.array(entry, { maxLength: 5 }),
      fc.array(hhmm, { maxLength: 4 }),
      fc.boolean(),
      (entries, marks, finished) => {
        const raw =
          entries.join("\n") +
          marks.map(partMarker).join("") +
          (finished ? DONE : "");
        assert.deepEqual(dayProgress(raw), {
          done: finished,
          through: marks.at(-1) ?? null,
        });
      },
    ),
    RUNS,
  );
});

test("an impossible time is not a resume point, and CRLF files read the same", () => {
  assert.equal(
    dayProgress("## 10:00 [text]\n\nx\n<!-- processed-through: 99:99 -->\n")
      .through,
    null,
  );
  assert.deepEqual(
    dayProgress(
      "## 10:00 [text]\r\n\r\nx\r\n<!-- processed-through: 10:00 -->\r\n",
    ),
    { done: false, through: "10:00" },
  );
});

test("a day is done only by its processed mark, never by a summary alone", () => {
  const raw = "## 10:00 [text]\n\nпривет\n";
  // Сводку скилл пишет до отметки: обрыв между ними оставил бы остаток дня неразобранным.
  assert.equal(isDayDone({ raw, summaryExists: true }), false);
  assert.equal(isDayDone({ raw, summaryExists: false }), false);
  assert.equal(
    isDayDone({ raw: raw + partMarker("10:00"), summaryExists: true }),
    false,
  );
  assert.equal(isDayDone({ raw: raw + DONE, summaryExists: false }), true);
  // Дня без транскрипта отмечать нечем: его делает сводка.
  assert.equal(isDayDone({ raw: null, summaryExists: true }), true);
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

test("the undone day that just left the window is named, not dropped silently", () => {
  const leaving = shiftDate(YESTERDAY, -LOOKBACK_DAYS);
  const days = new Map<string, DayState>([
    [leaving, { raw: "## 10:00 [text]\n\nдень\n", summaryExists: true }],
  ]);
  const read = (date: string): DayState =>
    days.get(date) ?? { raw: null, summaryExists: false };
  assert.equal(droppedDay(YESTERDAY, read), leaving);
  days.set(leaving, {
    raw: `## 10:00 [text]\n\nдень\n${DONE}`,
    summaryExists: true,
  });
  assert.equal(droppedDay(YESTERDAY, read), null);
  // Дня без транскрипта догонять было нечего.
  days.delete(leaving);
  assert.equal(droppedDay(YESTERDAY, read), null);
});
