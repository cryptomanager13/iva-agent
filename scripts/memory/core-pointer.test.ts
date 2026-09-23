/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Детерминированная половина ночной работы с CORE: указатель последнего дня ведёт код,
// и код же сторожит, что ход не унёс с собой чужую секцию. Пример-якоря держат контракт
// ночи (день без нового — файл байт в байт, кроме указателя; снесённая секция — откат и
// алерт; указателя нет — он дописывается), свойства перебирают то, что перечислением не
// закрыть: произвольные секции, чужие строки, CRLF, мусор.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { coreDamage, setLastDayPointer } from "#lib/core-clamp.ts";
import { coreDamageAlert } from "../lib/notice-policy.ts";

const RUNS = { numRuns: 300 };
const ru = (_en: string, russian: string): string => russian;

/** CORE такой, какой отдаёт установка: шаблон плюс секция, которую завёл сам владелец. */
const CORE = [
  "# CORE",
  "",
  "## Пользователь",
  "",
  "- Сергей — владелец, язык ru, обращаться на «ты».",
  "",
  "## Предпочтения",
  "",
  "- 2026-07: отвечать коротко, без преамбул",
  "",
  "## Мои заметки",
  "",
  "- секция вне шаблона, модель её не трогает",
  "",
  "## Указатели",
  "",
  "- Последний день: summaries/daily/2026-08-20 · Индекс: MOC.md",
  "",
].join("\n");

function pointerIndexOf(text: string, newline = "\n"): number {
  const at = text
    .split(newline)
    .findIndex((line) => line.includes("Последний день"));
  assert.notEqual(at, -1, "fixture must carry a pointer line");
  return at;
}

/** Индексы строк, которые изменились: контракт «правится ровно одна строка». */
function changedLines(before: string, after: string, newline = "\n"): number[] {
  const from = before.split(newline);
  const to = after.split(newline);
  assert.equal(to.length, from.length, "no line may appear or disappear");
  return from.flatMap((line, index) => (line === to[index] ? [] : [index]));
}

test("a day with nothing new leaves CORE byte-identical except the pointer line", () => {
  // Ночь файл не открывала: после хода он ровно тот же.
  const afterTurn = CORE;
  assert.equal(coreDamage(CORE, afterTurn).damaged, false);

  const pointed = setLastDayPointer(afterTurn, "2026-08-23");

  assert.deepEqual(changedLines(CORE, pointed), [pointerIndexOf(CORE)]);
  assert.equal(pointed, CORE.replace("2026-08-20", "2026-08-23"));
  // Хвост строки (индекс MOC) переживает правку.
  assert.match(pointed, /2026-08-23 · Индекс: MOC\.md/u);
});

test("an old CORE with the vault/ prefix is normalized in place", () => {
  const legacy = CORE.replace(
    "- Последний день: summaries/daily/2026-08-20 · Индекс: MOC.md",
    "- Последний день: vault/summaries/daily/2026-08-20 · Индекс: vault/MOC.md",
  );

  const pointed = setLastDayPointer(legacy, "2026-08-23");

  // Меняется вся ссылка целиком, хвост строки (индекс) остаётся как был у владельца.
  assert.deepEqual(changedLines(legacy, pointed), [pointerIndexOf(legacy)]);
  assert.equal(
    pointed.split("\n")[pointerIndexOf(legacy)],
    "- Последний день: summaries/daily/2026-08-23 · Индекс: vault/MOC.md",
  );
  assert.equal(setLastDayPointer(pointed, "2026-08-23"), pointed);
});

test("re-running the same night writes nothing at all", () => {
  const pointed = setLastDayPointer(CORE, "2026-08-23");
  assert.equal(setLastDayPointer(pointed, "2026-08-23"), pointed);
});

test("a heading dropped by the turn is restored, and the alert names it", () => {
  const mangled = CORE.replace(
    "## Мои заметки\n\n- секция вне шаблона, модель её не трогает\n\n",
    "",
  );
  const damage = coreDamage(CORE, mangled);

  assert.equal(damage.damaged, true);
  assert.deepEqual(damage.lostHeadings, ["Мои заметки"]);
  assert.equal(damage.emptied, false);

  const alert = coreDamageAlert(ru, damage.lostHeadings);
  assert.match(alert, /Мои заметки/u);
  assert.match(alert, /CORE\.md/u);
  assert.match(alert, /vault\/CORE\.md/u); // что сделать (ADR-0007)

  // Откат — это байт в байт предыдущий файл, и указатель ставится всё равно.
  const restored = CORE;
  const pointed = setLastDayPointer(restored, "2026-08-23");
  assert.deepEqual(changedLines(CORE, pointed), [pointerIndexOf(CORE)]);
});

test("an emptied CORE is damage even without headings to name", () => {
  const wiped = coreDamage(CORE, "   \n");
  assert.equal(wiped.emptied, true);
  assert.equal(wiped.damaged, true);
  assert.deepEqual(wiped.lostHeadings, [
    "Пользователь",
    "Предпочтения",
    "Мои заметки",
    "Указатели",
  ]);

  // Файл без заголовков называть нечем — алерт всё равно обязан сказать, что случилось.
  const headless = coreDamage("просто текст без заголовков\n", "");
  assert.equal(headless.damaged, true);
  assert.deepEqual(headless.lostHeadings, []);
  assert.match(
    coreDamageAlert(ru, headless.lostHeadings),
    /опустошила CORE\.md/u,
  );
});

test("an edited line is not damage: that is the night's job", () => {
  const edited = CORE.replace(
    "- 2026-07: отвечать коротко, без преамбул",
    "- 2026-08: сначала вывод, потом детали",
  );
  assert.equal(coreDamage(CORE, edited).damaged, false);
  // Дописанная секция тоже не потеря.
  assert.equal(
    coreDamage(CORE, `${CORE}\n## Новое\n\n- факт\n`).damaged,
    false,
  );
});

test("a section whose body was emptied under a surviving heading is damage", () => {
  const hollowedPreferences = coreDamage(
    CORE,
    CORE.replace("- 2026-07: отвечать коротко, без преамбул", ""),
  );
  assert.equal(hollowedPreferences.damaged, true);
  assert.deepEqual(hollowedPreferences.hollowedHeadings, ["Предпочтения"]);
  assert.deepEqual(hollowedPreferences.lostHeadings, []);
  assert.equal(hollowedPreferences.emptied, false);

  // Пользовательская секция вне шаблона: тело из пробелов тоже пусто.
  const hollowedNotes = coreDamage(
    CORE,
    CORE.replace("- секция вне шаблона, модель её не трогает", "   "),
  );
  assert.deepEqual(hollowedNotes.hollowedHeadings, ["Мои заметки"]);

  const hollowedBoth = coreDamage(
    CORE,
    CORE.replace("- 2026-07: отвечать коротко, без преамбул", "").replace(
      "- секция вне шаблона, модель её не трогает",
      "   ",
    ),
  );
  assert.deepEqual(hollowedBoth.hollowedHeadings, [
    "Предпочтения",
    "Мои заметки",
  ]);

  const alert = coreDamageAlert(ru, [
    ...hollowedBoth.lostHeadings,
    ...hollowedBoth.hollowedHeadings,
  ]);
  assert.match(alert, /Предпочтения/u);
  assert.match(alert, /vault\/CORE\.md/u);
});

test("an empty body that stays empty, or fills up, is not damage", () => {
  const blank = CORE.replace("- 2026-07: отвечать коротко, без преамбул", "");
  assert.equal(coreDamage(blank, blank).damaged, false);
  assert.equal(coreDamage(blank, CORE).damaged, false);

  const renamed = coreDamage(
    CORE,
    CORE.replace("## Мои заметки", "## Заметки"),
  );
  assert.deepEqual(renamed.lostHeadings, ["Мои заметки"]);
  assert.deepEqual(renamed.hollowedHeadings, []);

  // Идентичный файл не потеря ни для одного входа.
  fc.assert(
    fc.property(
      fc.oneof(
        coreDocument.map((document) => document.text),
        junk,
      ),
      (text) => {
        assert.equal(coreDamage(text, text).damaged, false);
      },
    ),
    RUNS,
  );
});

test("тела одинаковых заголовков склеиваются: выхолощенная секция видна", () => {
  const duplicateBefore = [
    "# CORE",
    "",
    "## Предпочтения",
    "",
    "- главное лежит в первой секции",
    "",
    "## Предпочтения",
    "",
    "## Указатели",
    "",
    "- Последний день: summaries/daily/2026-08-20 · Индекс: MOC.md",
    "",
  ].join("\n");
  const duplicateAfter = duplicateBefore.replace(
    "- главное лежит в первой секции",
    "",
  );

  const damage = coreDamage(duplicateBefore, duplicateAfter);

  assert.equal(damage.damaged, true);
  assert.deepEqual(damage.hollowedHeadings, ["Предпочтения"]);
  assert.deepEqual(damage.lostHeadings, []);
});

test("a first-run vault without CORE is not damage", () => {
  assert.equal(coreDamage("", "").damaged, false);
  assert.equal(coreDamage("", "# CORE\n").damaged, false);
});

test("the pointer is inserted into an existing Pointers section that lost the line", () => {
  const withoutLine = CORE.replace(
    "- Последний день: summaries/daily/2026-08-20 · Индекс: MOC.md\n",
    "- Индекс: MOC.md\n",
  );

  const pointed = setLastDayPointer(withoutLine, "2026-08-23");

  assert.equal(
    pointed,
    withoutLine.replace(
      "- Индекс: MOC.md\n",
      "- Индекс: MOC.md\n- Последний день: summaries/daily/2026-08-23\n",
    ),
  );
  assert.equal(setLastDayPointer(pointed, "2026-08-23"), pointed);
});

test("the pointer lands inside the section, not at the end of the file", () => {
  const text = [
    "# CORE",
    "",
    "## Указатели",
    "",
    "- Индекс: MOC.md",
    "",
    "## Мои заметки",
    "",
    "- хвост файла",
    "",
  ].join("\n");

  const pointed = setLastDayPointer(text, "2026-08-23");

  assert.match(
    pointed,
    /- Индекс: MOC\.md\n- Последний день: summaries\/daily\/2026-08-23\n\n## Мои заметки/u,
  );
});

test("a missing Pointers section is appended at the end", () => {
  const text = "# CORE\n\n## Пользователь\n\n- Сергей\n";

  const pointed = setLastDayPointer(text, "2026-08-23");

  assert.equal(
    pointed,
    `${text}\n## Указатели\n\n- Последний день: summaries/daily/2026-08-23\n`,
  );
  assert.equal(setLastDayPointer(pointed, "2026-08-23"), pointed);
});

test("an empty CORE gets the section and nothing else", () => {
  assert.equal(
    setLastDayPointer("", "2026-08-23"),
    "## Указатели\n\n- Последний день: summaries/daily/2026-08-23\n",
  );
});

test("a pointer line without a value keeps its tail readable", () => {
  const text = "## Указатели\n\n- Последний день: · Индекс: MOC.md\n";
  assert.equal(
    setLastDayPointer(text, "2026-08-23"),
    "## Указатели\n\n- Последний день: summaries/daily/2026-08-23 · Индекс: MOC.md\n",
  );
});

test("a bad date is a programming error, not a file to repair", () => {
  assert.throws(() => setLastDayPointer(CORE, "2026-8-3"), TypeError);
  assert.throws(() => setLastDayPointer(CORE, "вчера"), TypeError);
});

// ── Проводка ночи ─────────────────────────────────────────────────────────────
// Сам rollup.ts здесь запустить нечем (он ведёт живого агента через eve/client), а
// порядок шагов — как раз то, чего юнит-тест функций не видит: снимок, снятый ПОСЛЕ
// хода, не доказывает ничего.

const rollupSource = readFileSync(
  new URL("rollup.ts", import.meta.url),
  "utf8",
);

test("CORE is snapshotted before the turn and pointed at the day after it", () => {
  const snapshot = rollupSource.indexOf("const coreBeforeTurn =");
  const turn = rollupSource.indexOf("buildPrompt(period, today, day)");
  const guard = rollupSource.indexOf("coreDamage(coreBeforeTurn, core)");
  const pointer = rollupSource.indexOf("setLastDayPointer(core, lastDay)");

  assert.ok(snapshot >= 0 && turn >= 0 && guard >= 0 && pointer >= 0);
  assert.ok(snapshot < turn, "a snapshot taken after the turn proves nothing");
  assert.ok(guard > turn, "damage is judged against the pre-turn file");
  assert.ok(guard < pointer, "restore first, only then point at the day");
  // Список имён для alert собирается из обоих видов потери: пропавшие и выхолощенные секции.
  assert.match(
    rollupSource,
    /\.\.\.damage\.lostHeadings,\s*\.\.\.damage\.hollowedHeadings,/u,
  );
  assert.match(rollupSource, /coreDamageAlert\(tr, damagedHeadings\)/u);
});

test("the daily prompt leaves an empty day's CORE alone", () => {
  assert.match(rollupSource, /do not open or write CORE\.md/u);
  assert.match(rollupSource, /never rewrite the file/u);
  assert.match(rollupSource, /keep every existing section/u);
  // Указатель — работа кода, и модель об этом больше не просят.
  assert.doesNotMatch(
    rollupSource,
    /the pointer to the last day \(\$\{yesterday\}\)/u,
  );
});

// ── Свойства ──────────────────────────────────────────────────────────────────

const isoDate = fc
  .tuple(
    fc.integer({ min: 2000, max: 2099 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(
    ([y, m, d]) =>
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  );

// Чужая строка: что угодно, кроме второго заголовка и второго указателя — иначе свойство
// «изменилась ровно одна строка» проверяло бы уже другой файл.
const filler = fc
  .string({ unit: "grapheme", maxLength: 40 })
  .map((value) => value.replaceAll(/[\r\n]/gu, " "))
  .filter(
    (value) =>
      !value.trimStart().startsWith("#") &&
      !/Последний день|Last day/u.test(value),
  );

const sectionName = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 20 })
  .map((value) => value.replaceAll(/[\r\n#]/gu, " ").trim())
  .filter(
    (value) => value.length > 0 && !/^(Указатели|Pointers)$/u.test(value),
  );

const section = fc
  .tuple(sectionName, fc.array(filler, { maxLength: 3 }))
  .map(([name, lines]) => [`## ${name}`, "", ...lines, ""]);

/** CORE из шаблона со случайными лишними секциями и строками. */
const coreDocument = fc
  .record({
    before: fc.array(section, { maxLength: 3 }),
    after: fc.array(section, { maxLength: 2 }),
    insidePointers: fc.array(filler, { maxLength: 2 }),
    old: isoDate,
    // Установка могла остаться со старым путём — правка обязана его нормализовать.
    oldPrefix: fc.constantFrom("", "vault/"),
    tail: fc.constantFrom(
      "",
      " · Индекс: MOC.md",
      "  ·  Индекс: MOC.md · и ещё что-то",
    ),
    crlf: fc.boolean(),
    finalNewline: fc.boolean(),
  })
  .map((shape) => {
    const newline = shape.crlf ? "\r\n" : "\n";
    const lines = [
      "# CORE",
      "",
      ...shape.before.flat(),
      "## Указатели",
      "",
      ...shape.insidePointers,
      `- Последний день: ${shape.oldPrefix}summaries/daily/${shape.old}${shape.tail}`,
      "",
      ...shape.after.flat(),
    ];
    const text = lines.join(newline) + (shape.finalNewline ? newline : "");
    return { text, newline, tail: shape.tail };
  });

test("property: the pointer edit moves exactly one line and nothing else", () => {
  fc.assert(
    fc.property(coreDocument, isoDate, ({ text, newline, tail }, date) => {
      const pointed = setLastDayPointer(text, date);
      const at = pointerIndexOf(text, newline);
      const expected = text
        .split(newline)
        .map((line, index) =>
          index === at
            ? `- Последний день: summaries/daily/${date}${tail}`
            : line,
        )
        .join(newline);

      assert.equal(pointed, expected);
      assert.deepEqual(changedLines(text, pointed, newline).length <= 1, true);
    }),
    RUNS,
  );
});

test("property: the pointer edit is idempotent", () => {
  fc.assert(
    fc.property(coreDocument, isoDate, ({ text }, date) => {
      const once = setLastDayPointer(text, date);
      assert.equal(setLastDayPointer(once, date), once);
    }),
    RUNS,
  );
});

// Мусор: пустой файл, файл без заголовков, CRLF, одинокие суррогаты, чужой markdown.
const junk = fc.oneof(
  fc.constant(""),
  fc.constant("\n"),
  fc.constant("\r\n\r\n"),
  fc.constant("# CORE"),
  fc.constant("no headings at all, just prose"),
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ unit: "grapheme", maxLength: 200 }),
  fc
    .array(fc.string({ unit: "grapheme", maxLength: 20 }), { maxLength: 8 })
    .map((lines) => lines.join("\r\n")),
);

test("property: junk in, pointer out — never a throw, always idempotent", () => {
  fc.assert(
    fc.property(junk, isoDate, (text, date) => {
      const once = setLastDayPointer(text, date);
      assert.ok(once.includes(`summaries/daily/${date}`));
      assert.equal(setLastDayPointer(once, date), once);
      // Ни одна прежняя строка не потеряна: указатель только дописывает.
      assert.equal(
        coreDamage(text, once).damaged,
        false,
        "the pointer edit must never look like damage",
      );
    }),
    RUNS,
  );
});
