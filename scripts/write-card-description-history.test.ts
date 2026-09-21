/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Смена факта не проходит молча: прежнее значение Compiled Truth (frontmatter description)
// уезжает в append-only ## History датированной строкой. Ночной rollup передаёт description
// на КАЖДОМ UPDATE и без нужды его не переписывает, поэтому повтор той же формулировки не
// имеет права ни ронять ход отказом, ни копить History на перестановку слов, а смена
// значения не имеет права исчезнуть без следа. Тесты идут через write_card — тот же шов,
// что у модели.
import "./lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../agent/lib/frontmatter.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-desc-history-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
for (const dir of ["contacts", "projects", "notes"])
  mkdirSync(join(VAULT, "cards", dir), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const writeCard = (await import("../agent/tools/write_card.ts")).default;

type WriteCardInput = Parameters<typeof writeCard.execute>[0];
type WriteCardResult = {
  action: string;
  error: string;
  file: string;
  ok: boolean;
};
type ParseSchema<T> = { parse: (value: unknown) => T };
const inputSchema =
  writeCard.inputSchema as unknown as ParseSchema<WriteCardInput>;
const testTool = writeCard as unknown as {
  execute: (input: WriteCardInput) => Promise<WriteCardResult>;
};
const call = (args: unknown) => testTool.execute(inputSchema.parse(args));

const DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "UTC",
  year: "numeric",
}).format(new Date());

const card = (rel: string) => readFileSync(join(VAULT, rel), "utf8");
const description = (rel: string) =>
  parseFrontmatter(card(rel)).fields?.description;
/** Строки-факты ## History: буллеты между её заголовком и следующим H2. */
const historyFactLines = (rel: string): string[] => {
  const lines = parseFrontmatter(card(rel)).body.split("\n");
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
};

/** Один шаг ночного ролловера: карточка проекта с описанием и фактом в теле. */
const add = (title: string, desc: string, body: string) =>
  call({
    body,
    description: desc,
    operation: "ADD",
    tags: ["work", "promo"],
    title,
    type: "project",
  });
const update = (title: string, desc: string, body: string) =>
  call({
    body,
    description: desc,
    operation: "UPDATE",
    tags: ["work", "promo"],
    title,
    type: "project",
  });

test("UPDATE со сменой description оставляет прежнее значение в ## History с датой", async () => {
  const created = await add(
    "TDI Group",
    "работает в TDI Group",
    "Работает в TDI Group.",
  );
  assert.equal(created.ok, true, created.error);
  const changed = await update(
    "TDI Group",
    "работает в Majento",
    "Смена подрядчика на Majento.",
  );
  assert.equal(changed.ok, true, changed.error);
  assert.equal(description(created.file), "работает в Majento");
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: работает в TDI Group`,
  ]);
});

test("повтор того же UPDATE идемпотентен: файл не меняется", async () => {
  const created = await add(
    "Дидокс",
    "интеграция ДиДокс",
    "Интеграция с ДиДокс.",
  );
  assert.equal(created.ok, true, created.error);
  const first = await update(
    "Дидокс",
    "интеграция ДиДокс и Billz",
    "Подключили Billz.",
  );
  assert.equal(first.ok, true, first.error);
  const afterFirst = card(created.file);
  const replay = await update(
    "Дидокс",
    "интеграция ДиДокс и Billz",
    "Подключили Billz.",
  );
  assert.equal(replay.ok, true, replay.error);
  assert.equal(card(created.file), afterFirst);
});

test("тот же description не добавляет ни строки в History", async () => {
  const created = await add(
    "Стинг Лонч",
    "лонч бренда Стинг",
    "Лонч бренда Стинг.",
  );
  assert.equal(created.ok, true, created.error);
  const next = await update(
    "Стинг Лонч",
    "лонч бренда Стинг",
    "Перенесли запуск на пятницу.",
  );
  assert.equal(next.ok, true, next.error);
  assert.equal(card(created.file).includes("## History"), false);
});

test("перестановка слов — смена факта: обе формулировки остаются в карточке", async () => {
  const created = await add(
    "Медиаплан Q3",
    "ведёт медиаплан Q3",
    "Ведёт медиаплан Q3.",
  );
  assert.equal(created.ok, true, created.error);
  const reworded = await update(
    "Медиаплан Q3",
    "медиаплан Q3 ведёт",
    "Уточнили бюджет.",
  );
  assert.equal(reworded.ok, true, reworded.error);
  assert.equal(description(created.file), "медиаплан Q3 ведёт");
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: ведёт медиаплан Q3`,
  ]);
});

// Один и тот же набор слов в другом порядке — другой факт: «с 5 до 9» и «с 9 до 5»
// описывают противоположный рост, «Anna reports to Boris» и «Boris reports to Anna» —
// противоположное подчинение. Мультимножество слов такую пару не различает, и прежнее
// значение пропадало: ни в frontmatter (там новое), ни в History (туда не попало).
test("смена факта тем же набором слов остаётся в History", async () => {
  const pairs: [string, string][] = [
    ["цена выросла с 5 до 9", "цена выросла с 9 до 5"],
    ["Anna reports to Boris", "Boris reports to Anna"],
  ];
  for (const [index, [from, to]] of pairs.entries()) {
    const title = `Порядок слов ${index}`;
    const created = await add(title, from, `Факт про «${from}».`);
    assert.equal(created.ok, true, created.error);
    const changed = await update(title, to, `Факт про «${to}».`);
    assert.equal(changed.ok, true, changed.error);
    assert.equal(description(created.file), to);
    assert.deepEqual(
      historyFactLines(created.file),
      [`- ${DAY}: ${from}`],
      `прежнее значение «${from}» исчезло без следа`,
    );
  }
});

// Знак — носитель смысла: «+12» и «-12» — противоположные факты, «> 5» и «< 5» —
// противоположные пороги, «$5» и «5» — разные величины, «✅» и «❌» — разные статусы,
// «5-9» и «59» — разные числа. Выкусывать их значило бы терять смену факта без следа.
test("знак как единственный носитель смысла — смена факта", async () => {
  const pairs: [string, string][] = [
    ["рост +12 процентов", "рост -12 процентов"],
    ["маржа > 5 процентов", "маржа < 5 процентов"],
    ["бюджет $5", "бюджет 5"],
    ["релиз готов ✅", "релиз готов ❌"],
    ["смена 5-9", "смена 59"],
  ];
  for (const [index, [from, to]] of pairs.entries()) {
    const title = `Знак ${index}`;
    const created = await add(title, from, `Факт про «${from}».`);
    assert.equal(created.ok, true, created.error);
    const changed = await update(title, to, `Факт про «${to}».`);
    assert.equal(changed.ok, true, changed.error);
    assert.equal(description(created.file), to);
    assert.deepEqual(
      historyFactLines(created.file),
      [`- ${DAY}: ${from}`],
      `прежнее значение «${from}» исчезло без следа`,
    );
  }
});

// Прощается только то, что смысла не несёт: регистр, ё/е, лишние пробелы и пунктуация по
// краям слова. Такая пара — тот же факт, и History от неё не растёт.
test("регистр, ё/е, пробелы и обрамляющая пунктуация сменой факта не считаются", async () => {
  const pairs: [string, string][] = [
    ["ведёт проект Pepsi", "Ведёт проект Pepsi!"],
    ["работает в TDI Group", "«Работает в TDI Group»"],
    ["он потратил все", "он потратил всё"],
    ["выручка 1 000 сум", "выручка 1\u00a0000 сум"],
  ];
  for (const [index, [from, to]] of pairs.entries()) {
    const title = `Мелочь ${index}`;
    const created = await add(title, from, `Факт про «${from}».`);
    assert.equal(created.ok, true, created.error);
    const reworded = await update(title, to, `Факт про «${to}».`);
    assert.equal(reworded.ok, true, reworded.error);
    assert.equal(description(created.file), to);
    assert.deepEqual(
      historyFactLines(created.file),
      [],
      `«${from}» и «${to}» — один факт, History расти не должна`,
    );
  }
});

test("цепочка UPDATE не теряет ни одного прежнего значения", async () => {
  const created = await add("Сплендор", "ведёт сплендор", "Ведёт сплендор.");
  assert.equal(created.ok, true, created.error);
  for (const desc of ["ведёт сплендор и Сайёру", "ведёт только Сайёру"]) {
    const step = await update("Сплендор", desc, `Факт про ${desc}.`);
    assert.equal(step.ok, true, step.error);
  }
  assert.equal(description(created.file), "ведёт только Сайёру");
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: ведёт сплендор`,
    `- ${DAY}: ведёт сплендор и Сайёру`,
  ]);
});

test("возврат к прежней формулировке не дублирует History", async () => {
  const created = await add("Pepsi Gamer", "первый вариант описания", "Факт.");
  assert.equal(created.ok, true, created.error);
  const there = await update(
    "Pepsi Gamer",
    "второй вариант описания",
    "Факт 2.",
  );
  assert.equal(there.ok, true, there.error);
  const back = await update(
    "Pepsi Gamer",
    "первый вариант описания",
    "Факт 3.",
  );
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: первый вариант описания`,
    `- ${DAY}: второй вариант описания`,
  ]);
});

test("SUPERSEDE не записывает уже лежащее в History описание второй раз", async () => {
  const created = await add(
    "Сайёра",
    "ведёт проекты Сайёры",
    "Ведёт проекты Сайёры.",
  );
  assert.equal(created.ok, true, created.error);
  const replaced = await call({
    body: "Ведёт проекты Маженто.",
    description: "ведёт проекты Маженто",
    history_entry: "Ведёт проекты Сайёры.",
    operation: "SUPERSEDE",
    tags: ["work", "promo"],
    title: "Сайёра",
    type: "project",
  });
  assert.equal(replaced.ok, true, replaced.error);
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: Ведёт проекты Сайёры.`,
  ]);
});

test("карточка без description не получает выдуманной строки History", async () => {
  mkdirSync(join(VAULT, "cards", "projects"), { recursive: true });
  const rel = "cards/projects/legacy.md";
  writeFileSync(
    join(VAULT, rel),
    [
      "---",
      "type: project",
      "name: Legacy",
      "tags: [work]",
      "status: active",
      "---",
      "",
      "# Legacy",
      "",
      "Старый факт без описания.",
      "",
    ].join("\n"),
  );
  const updated = await update("Legacy", "появилось описание", "Новый факт.");
  assert.equal(updated.ok, true, updated.error);
  assert.equal(description(rel), "появилось описание");
  assert.equal(card(rel).includes("## History"), false);
});

// Карточка с двумя ## History: границы такой секции неоднозначны, судить по ней нельзя,
// поэтому запись не сливает их в одну и не переносит с места — новая строка ложится в
// последнюю, и одна запись остаётся одной строкой. Чужое не переписано и не переставлено.
test("две секции History не сливаются: строка ложится в последнюю", async () => {
  mkdirSync(join(VAULT, "cards", "projects"), { recursive: true });
  const rel = "cards/projects/two-hist.md";
  writeFileSync(
    join(VAULT, rel),
    [
      "---",
      "type: project",
      "name: Two Hist",
      'description: "старое значение"',
      "tags: [work]",
      "status: active",
      "---",
      "",
      "# Two Hist",
      "",
      "Тело.",
      "",
      "## History",
      "",
      "- 2025-01-01: первый",
      "",
      "## Log",
      "",
      "- 2025-02-02: лог",
      "",
      "## History",
      "",
      "- 2025-03-03: второй",
      "",
    ].join("\n"),
  );
  const updated = await update("Two Hist", "новое значение", "Новый факт.");
  assert.equal(updated.ok, true, updated.error);
  const out = card(rel);
  // ## Log пересобирается в конец — так его ведёт UPDATE и на main; обе History остались
  // двумя секциями, и ни одна не сдвинулась относительно другой.
  assert.deepEqual(
    [...out.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ["History", "History", "Log"],
  );
  assert.match(out, /## History\n\n- 2025-01-01: первый\n/);
  assert.match(
    out,
    new RegExp(
      `## History\\n\\n- 2025-03-03: второй\\n- ${DAY}: старое значение`,
    ),
  );
});

// History датирует только код. Значение, которое выглядит как датированная строка, —
// данные: модель не выбирает дату записи и не подделывает порядок событий. Модель не
// пишет ## History своим телом, и то же правило держит ценность строки для человека.
test("дата в вытесненном описании — данные: строку датирует код", async () => {
  const created = await add(
    "ЦРУ",
    "2020-01-01: работал в ЦРУ",
    "Работал в ЦРУ.",
  );
  assert.equal(created.ok, true, created.error);
  const changed = await update("ЦРУ", "работает в Majento", "Сменил работу.");
  assert.equal(changed.ok, true, changed.error);
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: 2020-01-01: работал в ЦРУ`,
  ]);
});

// Значение приходит из frontmatter, который мог написать человек: перевод строки и
// ведущий буллет не имеют права превратиться во вторую строку или в новую секцию.
test("многострочное описание уезжает в History одной строкой", async () => {
  mkdirSync(join(VAULT, "cards", "projects"), { recursive: true });
  const rel = "cards/projects/wrapped.md";
  writeFileSync(
    join(VAULT, rel),
    [
      "---",
      "type: project",
      "name: Wrapped",
      'description: "- 1999-12-31: подделка\\n## Log\\n\\n- чужая строка"',
      "tags: [work]",
      "status: active",
      "---",
      "",
      "# Wrapped",
      "",
      "Нынешняя истина.",
      "",
    ].join("\n"),
  );
  const updated = await update("Wrapped", "вытеснило описание", "Новый факт.");
  assert.equal(updated.ok, true, updated.error);
  assert.deepEqual(historyFactLines(rel), [
    `- ${DAY}: - 1999-12-31: подделка ## Log - чужая строка`,
  ]);
  assert.equal(card(rel).match(/^## /gm)?.length, 2);
});

// UPDATE сам убрал прежнее описание в History, а следующим вызовом модель делает
// SUPERSEDE и называет ровно тот факт, который вытесняет (он всё ещё стоит в теле).
// Строка в History уже есть — значит её не пишут второй раз, но и не отказывают: ночной
// rollup не имеет права упасть на законном вызове, а факт не имеет права потеряться.
test("SUPERSEDE с уже лежащим в History фактом проходит и не дублирует строку", async () => {
  const created = await add(
    "TDI Group Clash",
    "работает в TDI Group",
    "Работает в TDI Group.",
  );
  assert.equal(created.ok, true, created.error);
  const moved = await update(
    "TDI Group Clash",
    "работает в Majento",
    "Обсуждали бюджет.",
  );
  assert.equal(moved.ok, true, moved.error);
  const replaced = await call({
    body: "Работает в Majento с марта.",
    description: "работает в Majento",
    history_entry: "работает в TDI Group",
    operation: "SUPERSEDE",
    tags: ["work", "promo"],
    title: "TDI Group Clash",
    type: "project",
  });
  assert.equal(replaced.ok, true, replaced.error);
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: работает в TDI Group`,
  ]);
});

// Та же пара, но датированная строка: две даты у одного факта — это не два вытеснения,
// а один факт, записанный дважды. Строка одна.
test("датированный history_entry о том же факте не даёт второй строки", async () => {
  const created = await add(
    "Сайёра Clash",
    "ведёт проекты Сайёры",
    "Ведёт проекты Сайёры.",
  );
  assert.equal(created.ok, true, created.error);
  const moved = await update(
    "Сайёра Clash",
    "ведёт проекты Majento",
    "Ведёт проекты Majento.",
  );
  assert.equal(moved.ok, true, moved.error);
  const replaced = await call({
    body: "Ведёт только проекты Majento.",
    description: "ведёт проекты Majento",
    history_entry: "2026-03-01: ведёт проекты Сайёры.",
    operation: "SUPERSEDE",
    tags: ["work", "promo"],
    title: "Сайёра Clash",
    type: "project",
  });
  assert.equal(replaced.ok, true, replaced.error);
  assert.deepEqual(historyFactLines(created.file), [
    `- ${DAY}: ведёт проекты Сайёры`,
  ]);
});
