/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// PBT: у произвольной последовательности ADD/UPDATE/SUPERSEDE ни одно значение description,
// которое когда-либо легло в карточку, не исчезает без следа — оно либо стоит во frontmatter
// сейчас, либо лежит в ## History. Инвариант проверяется на mergeCard (чистый шов стора): файл
// сюда не нужен, а отказ вызова ничего не пишет, поэтому «потерять» значение может только
// успешная запись. Воспроизведение провала: seed печатается перед прогоном, подставь его в
// fc.assert(prop, { seed, path }).
//
// Оракул сверяет прежнее значение с текущим побайтно (после trim), ищет его текст в ## History
// дословно и прощает ровно то, что прощает правило: регистр, ё/е, лишние пробелы и пунктуацию
// по краям слова. Знаки прощаются только как краевая пунктуация: «рост +12» и «рост -12» —
// разные факты, и оракул обязан потребовать для пары строку в ## History. Порядок слов форма
// сохраняет, поэтому перестановка «с 5 до 9» → «с 9 до 5» тоже требует строки в ## History.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
// card-store импортирует соседей как "./x.js" — только этот хук делает из них .ts.
import "../../scripts/lib/ts-esm-hooks.ts";
import { parseFrontmatter } from "./frontmatter.ts";

const { mergeCard } = await import("./card-store.ts");

const SEED = Number(process.env.IVA_CARD_HISTORY_SEED ?? 20_260_921);
const DATE = "2026-09-21";

/** Различия, которые не считаются сменой факта: регистр, ё/е, лишние пробелы и пунктуация
 * по краям слова. Всё остальное значение несёт — «+12» против «-12» форма не сглаживает.
 * Порядок слов сохраняется намеренно: перестановка это другой факт. */
const shape = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/\s+/u)
    .map((word) => word.replace(EDGE_PUNCTUATION, ""))
    .filter(Boolean)
    .join(" ");

/** Обрамляющая пунктуация предложения: сама по себе она смысла не несёт. Знаки (+, -, <, >,
 * $, %, эмодзи) в неё не входят — они и есть смысл. */
const EDGE_PUNCTUATION = /^[.,;:!?…"'«»()]+|[.,;:!?…"'«»()]+$/gu;

const descriptionOf = (content: string) =>
  String(parseFrontmatter(content).fields?.description ?? "");

/** Текст ## History как он лежит в карточке: сверка идёт по нему, а не по нормализованной
 * форме, чтобы оракул не потерял различие, которое потеряла бы нормализация. */
function historyText(content: string): string {
  const lines = parseFrontmatter(content).body.split("\n");
  const start = lines.findIndex((line) =>
    /^ {0,3}##\s+History\s*$/i.test(line),
  );
  if (start < 0) return "";
  const facts: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,3}#{1,2}\s/.test(line)) break;
    facts.push(line);
  }
  return facts.join("\n");
}

/** Факты строк ## History без буллета и даты: форма сравнивается с формой значения, то есть
 * строка закрывает значение, отличающееся только регистром, ё/е, пробелами и краевой
 * пунктуацией. */
const historyFacts = (content: string): string[] =>
  historyText(content)
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[-*]\s+/, "")
        .replace(/^\d{4}-\d{2}-\d{2}:\s*/, ""),
    )
    .filter(Boolean);

const DESCRIPTIONS = [
  "работает в TDI Group",
  // Перестановка слов того же факта — другой факт: прежнее значение обязано остаться.
  "в TDI Group работает",
  "работает в Majento",
  "ведёт проект Pepsi Gamer",
  "проект Pepsi Gamer ведёт",
  "ведёт проект Pepsi Gamer и Стинг",
  // Один и тот же набор слов, противоположный смысл.
  "цена выросла с 5 до 9",
  "цена выросла с 9 до 5",
  "Anna reports to Boris",
  "Boris reports to Anna",
  // Только регистр и краевая пунктуация: сменой факта не считается.
  "работает в majento",
  "Работает в Majento",
  "работает в Majento!",
  // Знак как единственный носитель смысла: смена факта, прежнее значение обязано остаться.
  "рост +12 процентов",
  "рост -12 процентов",
  "маржа > 5 процентов",
  "маржа < 5 процентов",
  "бюджет $5",
  "бюджет 5",
  "релиз готов ✅",
  "релиз готов ❌",
  "смена 5-9",
  "смена 59",
];
const FACTS = [
  "Обсуждали бюджет на октябрь.",
  "Смена подрядчика на Majento.",
  "Перенос розыгрыша на пятницу.",
  "Подключили Billz.",
];

const stepArb = fc.record({
  description: fc.constantFrom(...DESCRIPTIONS),
  fact: fc.constantFrom(...FACTS),
  kind: fc.constantFrom("ADD", "UPDATE", "SUPERSEDE"),
});

test(`описание не исчезает без следа на любой цепочке ADD/UPDATE/SUPERSEDE (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.array(stepArb, { maxLength: 8, minLength: 1 }), (steps) => {
      let content: string | undefined;
      // Compiled Truth карточки: то, что вытесняет SUPERSEDE и обязан назвать history_entry.
      let truth = "Начальный факт карточки.";
      const landed: string[] = [];
      for (const step of steps) {
        const input = {
          body: step.fact,
          date: DATE,
          fields: {
            description: step.description,
            tags: ["work"],
            type: "project",
          },
          title: "Pepsi Gamer",
        };
        try {
          if (step.kind === "ADD") {
            // Вторая карточка ADD не создаётся — как и у модели, вызов просто отказывает.
            if (content !== undefined) continue;
            content = mergeCard({ ...input, operation: "ADD" }).content;
            truth = step.fact;
          } else if (step.kind === "UPDATE") {
            if (content === undefined) continue;
            content = mergeCard({
              ...input,
              existing: content,
              operation: "UPDATE",
            }).content;
          } else {
            if (content === undefined) continue;
            content = mergeCard({
              ...input,
              existing: content,
              historyEntry: truth,
              operation: "SUPERSEDE",
            }).content;
            truth = step.fact;
          }
        } catch {
          // Отказ ничего не пишет: значение в карточку не легло, и терять нечего.
          continue;
        }
        landed.push(step.description.trim());
        assert.equal(
          descriptionOf(content).trim(),
          step.description.trim(),
          `успешная запись обязана поставить своё описание во frontmatter:\n${content}`,
        );
      }
      if (content === undefined) return;
      const current = descriptionOf(content).trim();
      const history = historyText(content);
      const archived = historyFacts(content).map(shape);
      for (const [index, value] of landed.entries()) {
        const next = landed[index + 1];
        assert.ok(
          value === current ||
            history.includes(value) ||
            archived.includes(shape(value)) ||
            (next !== undefined && shape(value) === shape(next)),
          `прежнее описание «${value}» исчезло без следа:\n${content}`,
        );
      }
    }),
    { numRuns: 300, seed: SEED },
  );
});
