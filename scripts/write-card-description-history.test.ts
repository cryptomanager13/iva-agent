/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Смена факта не проходит молча: прежнее значение Compiled Truth (frontmatter description)
// уезжает в append-only ## History датированной строкой. Ночной rollup передаёт description
// на КАЖДОМ UPDATE и по инструкции его «заостряет», поэтому перефразировка не имеет права
// ни ронять ход отказом, ни копить архив на перестановку слов, а смена значения не имеет
// права исчезнуть без следа. Тесты идут через write_card — тот же шов, что у модели.
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

test("тот же description не добавляет ни строки в архив", async () => {
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

test("перестановка слов — не смена факта: архив не растёт, новая формулировка остаётся", async () => {
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
  assert.equal(card(created.file).includes("## History"), false);
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

test("возврат к прежней формулировке не дублирует архив", async () => {
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

test("SUPERSEDE не архивирует уже заархивированное описание второй раз", async () => {
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

test("карточка без description не получает выдуманной строки архива", async () => {
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
