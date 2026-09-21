/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// PBT: у произвольной последовательности ADD/UPDATE/SUPERSEDE ни одно значение description,
// которое когда-либо легло в карточку, не исчезает без следа — оно либо стоит во frontmatter
// сейчас, либо лежит в ## History. Инвариант проверяется на mergeCard (чистый шов стора): файл
// сюда не нужен, а отказ вызова ничего не пишет, поэтому «потерять» значение может только
// успешная запись. Воспроизведение провала: seed печатается перед прогоном, подставь его в
// fc.assert(prop, { seed, path }).
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
// card-store импортирует соседей как "./x.js" — только этот хук делает из них .ts.
import "../../scripts/lib/ts-esm-hooks.ts";
import { parseFrontmatter } from "./frontmatter.ts";

const { mergeCard } = await import("./card-store.ts");

const SEED = Number(process.env.IVA_CARD_HISTORY_SEED ?? 20_260_921);
const DATE = "2026-09-21";

/** «Тот же факт» в форме card-store: без регистра, пунктуации и порядка слов. */
const fact = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");

const descriptionOf = (content: string) =>
  String(parseFrontmatter(content).fields?.description ?? "");

/** Строки-факты ## History: буллеты между её заголовком и следующим H2. */
function historyFacts(content: string): string[] {
  const lines = parseFrontmatter(content).body.split("\n");
  const start = lines.findIndex((line) =>
    /^ {0,3}##\s+History\s*$/i.test(line),
  );
  if (start < 0) return [];
  const facts: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,3}#{1,2}\s/.test(line)) break;
    if (line.trim()) facts.push(line.trim());
  }
  return facts;
}

const DESCRIPTIONS = [
  "работает в TDI Group",
  // Перестановка слов того же факта: архив от неё расти не должен.
  "в TDI Group работает",
  "работает в Majento",
  "ведёт проект Pepsi Gamer",
  "проект Pepsi Gamer ведёт",
  "ведёт проект Pepsi Gamer и Стинг",
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
        landed.push(step.description);
        assert.equal(
          fact(descriptionOf(content)),
          fact(step.description),
          `успешная запись обязана поставить своё описание во frontmatter:\n${content}`,
        );
      }
      if (content === undefined) return;
      // Дата принадлежит архиву, а не факту: сверяем сам факт строки.
      const archived = historyFacts(content).map((line) =>
        fact(
          line.replace(/^[-*]\s+/, "").replace(/^\d{4}-\d{2}-\d{2}:\s*/, ""),
        ),
      );
      for (const value of landed)
        assert.ok(
          fact(descriptionOf(content)) === fact(value) ||
            archived.includes(fact(value)),
          `прежнее описание «${value}» исчезло без следа:\n${content}`,
        );
    }),
    { numRuns: 300, seed: SEED },
  );
});
