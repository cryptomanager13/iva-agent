/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Алиасы карточки: другое написание того же имени должно НАХОДИТЬСЯ поиском, а не жить
// в голове владельца. Тесты идут через тот же шов, что у модели: write_card → frontmatter,
// memory_search → выдача. FTS5 не транслитерирует (Пепси ≠ Pepsi), не чинит опечатки
// (медейка ≠ медийка) и не ловит падеж (Стинг ≠ Стинга) — единственный носитель этой связи
// в карточке aliases, поэтому их приём, слияние и мусор на входе — контракт записи.
import "./lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../agent/lib/frontmatter.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-aliases-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
for (const dir of ["contacts", "projects", "notes"])
  mkdirSync(join(VAULT, "cards", dir), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const writeCard = (await import("../agent/tools/write_card.ts")).default;
const { searchMemory } = await import("../agent/tools/memory_search.ts");
const { mergeCard } = await import("../agent/lib/card-store.ts");

type WriteCardInput = Parameters<typeof writeCard.execute>[0];
type WriteCardResult = {
  action: string;
  error: string;
  file: string;
  note?: string;
  ok: boolean;
};
type ParseSchema<T> = { parse: (value: unknown) => T };
const inputSchema =
  writeCard.inputSchema as unknown as ParseSchema<WriteCardInput>;
const testTool = writeCard as unknown as {
  execute: (input: WriteCardInput) => Promise<WriteCardResult>;
};
const call = (args: unknown) => testTool.execute(inputSchema.parse(args));

const fields = (rel: string) =>
  parseFrontmatter(readFileSync(join(VAULT, rel), "utf8")).fields ?? {};

const PROJECT = {
  operation: "ADD",
  type: "project",
  title: "Pepsi Gamer",
  description: "Промо-кампания с приёмом кодов и розыгрышем призов",
  tags: ["promo", "uz"],
  body: "Приём кодов идёт до конца месяца.",
};

test("ADD с aliases пишет их во frontmatter и схлопывает дубли по регистру", async () => {
  const res = await call({
    ...PROJECT,
    aliases: ["Пепси", "Пепси Геймер", "пепси геймер"],
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(fields(res.file).aliases, ["Пепси", "Пепси Геймер"]);
});

test("карточка находится по написанию, которого нет ни в title, ни в description", async () => {
  const cases = [
    {
      alias: "Sting",
      description: "Лонч-кампания бренда в Узбекистане",
      query: "Sting",
      title: "Стинг Лонч",
      type: "project",
    },
    {
      alias: "медейка",
      description: "План размещений на квартал",
      query: "медейка",
      title: "Медиаплан Q3",
      type: "project",
    },
    {
      alias: "Сплендор",
      description: "Владелица бренда, клиент агентства",
      query: "Сплендор",
      title: "Сайёра",
      type: "contact",
    },
  ];
  for (const { alias, description, query, title, type } of cases) {
    const res = await call({
      aliases: [alias],
      body: "Факт без имени бренда в теле.",
      description,
      operation: "ADD",
      tags: ["network", "promo"],
      title,
      type,
    });
    assert.equal(res.ok, true, res.error);
    const found = await searchMemory({ query });
    assert.equal(
      found.hits[0]?.file,
      res.file,
      `«${query}» должно первым делом находить ${res.file}, а нашло ${found.hits
        .map((hit) => `${hit.file}:${hit.score}`)
        .join(", ")}`,
    );
  }
});

test("UPDATE с aliases объединяет их с лежащими", async () => {
  const add = await call({
    ...PROJECT,
    aliases: ["СплендорТим"],
    title: "Сплендор Тим",
    type: "project",
  });
  assert.equal(add.ok, true, add.error);
  const update = await call({
    ...PROJECT,
    aliases: ["Splendor Team"],
    description: PROJECT.description,
    operation: "UPDATE",
    title: "Сплендор Тим",
    type: "project",
  });
  assert.equal(update.ok, true, update.error);
  assert.deepEqual(fields(add.file).aliases, ["СплендорТим", "Splendor Team"]);
});

test("UPDATE без aliases их не стирает", async () => {
  const add = await call({
    ...PROJECT,
    aliases: ["Дидокс"],
    title: "ДиДокс",
    type: "project",
  });
  assert.equal(add.ok, true, add.error);
  const update = await call({
    ...PROJECT,
    description: PROJECT.description,
    operation: "UPDATE",
    title: "ДиДокс",
    type: "project",
  });
  assert.equal(update.ok, true, update.error);
  assert.deepEqual(fields(add.file).aliases, ["Дидокс"]);
});

test("мусор в aliases отклоняется на входе, а не уезжает в карточку", () => {
  const garbage: unknown[] = [
    [""],
    ["   "],
    ["первая\nвторая"],
    [42],
    "Пепси",
    Array.from({ length: 200 }, (_, index) => `alias-${index}`),
    ["x".repeat(200)],
  ];
  for (const aliases of garbage)
    assert.throws(
      () => inputSchema.parse({ ...PROJECT, aliases }),
      `aliases=${JSON.stringify(aliases).slice(0, 60)} должен быть отклонён`,
    );
});

// Ночной rollup добавляет алиасы каждую ночь: без потолка на слиянии колонка meta
// распухает и выдача соседям размывается. Лежащие написания при этом не выбрасываются —
// чужая карточка не худеет от нашего вызова, — а непоместившиеся названы в ответе:
// молча пропавшее написание владелец не найдёт и не починит.
test("потолок алиасов держится на слиянии, лишние названы в ответе", async () => {
  const stored = Array.from({ length: 6 }, (_, index) => `Лежащий ${index}`);
  const added = await call({
    ...PROJECT,
    aliases: stored,
    title: "Потолок",
    type: "contact",
  });
  assert.equal(added.ok, true, added.error);

  const filled = await call({
    ...PROJECT,
    aliases: ["Новый 1", "Новый 2", "Новый 3", "Новый 4"],
    description: PROJECT.description,
    operation: "UPDATE",
    title: "Потолок",
    type: "contact",
  });
  assert.equal(filled.ok, true, filled.error);
  assert.deepEqual(fields(added.file).aliases, [
    ...stored,
    "Новый 1",
    "Новый 2",
  ]);
  assert.match(
    filled.note ?? "",
    /Новый 3, Новый 4/,
    "непоместившиеся алиасы должны быть названы в ответе",
  );

  const overflowed = await call({
    ...PROJECT,
    aliases: ["Третий 1", "Третий 2", "Третий 3"],
    description: PROJECT.description,
    operation: "UPDATE",
    title: "Потолок",
    type: "contact",
  });
  assert.equal(overflowed.ok, true, overflowed.error);
  assert.equal(fields(added.file).aliases.length, 8);
  assert.match(overflowed.note ?? "", /Третий 1, Третий 2, Третий 3/);
});

// ё и е для индекса — разные написания: FTS5 их не складывает, и схлопнутое при записи
// «Планерка» не находилось поиском вовсе, хотя именно так его и пишут. Ключ дедупа
// складывает только регистр и лишние пробелы; оба написания остаются в карточке.
test("ё и е — разные написания: оба лежат в карточке и оба находят её", async () => {
  const added = await call({
    ...PROJECT,
    aliases: ["Ёлка2", "Елка2", "Планёрка2", "Планерка2"],
    description: "Ретроспектива квартала",
    title: "Ёлкин План",
    type: "project",
  });
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(fields(added.file).aliases, [
    "Ёлка2",
    "Елка2",
    "Планёрка2",
    "Планерка2",
  ]);
  for (const query of ["Ёлка2", "Елка2", "Планёрка2", "Планерка2"]) {
    const found = await searchMemory({ query });
    assert.ok(
      found.hits.some((hit) => hit.file === added.file),
      `«${query}» обязано находить ${added.file}, а нашло ${found.hits
        .map((hit) => hit.file)
        .join(", ")}`,
    );
  }
});

test("непоместившийся алиас назван в note и на пути без изменений", async () => {
  const full = Array.from({ length: 8 }, (_, index) => `Стоящий ${index}`);
  const created = await call({
    ...PROJECT,
    aliases: full,
    body: "Факт.",
    description: "Полная карточка",
    title: "Полный",
    type: "contact",
  });
  assert.equal(created.ok, true, created.error);

  const noop = await call({
    ...PROJECT,
    body: "Факт.",
    description: "Полная карточка",
    operation: "NOOP",
    title: "Полный",
    type: "contact",
    aliases: ["Непустивший"],
  });
  assert.equal(noop.ok, true, noop.error);
  assert.equal(noop.action, "noop");
  assert.match(
    noop.note ?? "",
    /Непустивший/,
    "noop обязан назвать алиас, которому не хватило места",
  );

  // Реплей SUPERSEDE — тоже noop: алиас из него в карточку не попал и обязан быть назван.
  const replaced = await call({
    ...PROJECT,
    aliases: full,
    body: "Новое тело.",
    description: "новое описание",
    operation: "SUPERSEDE",
    history_entry: "2020-01-01: Факт.",
    title: "Полный",
    type: "contact",
  });
  assert.equal(replaced.ok, true, replaced.error);
  const replay = await call({
    ...PROJECT,
    aliases: ["Ещё Один"],
    body: "Новое тело.",
    description: "новое описание",
    operation: "SUPERSEDE",
    history_entry: "2020-01-01: Факт.",
    title: "Полный",
    type: "contact",
  });
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.action, "noop");
  assert.match(replay.note ?? "", /Ещё Один/);

  // Тот же ответ у самого слияния: NOOP, поданный прямо в mergeCard, называет то же самое.
  const merged = mergeCard({
    body: "Факт.",
    date: "2026-09-21",
    existing: readFileSync(join(VAULT, created.file), "utf8"),
    fields: {
      aliases: ["Непустивший"],
      description: "Полная карточка",
      tags: ["network"],
      type: "contact",
    },
    operation: "NOOP",
    title: "Полный",
  });
  assert.deepEqual(merged.droppedAliases, ["Непустивший"]);
});

// Одно и то же написание — это одно написание: регистр и лишние пробелы не делают его другим,
// а FTS5 складывает регистр сам. ё/е — НЕ одно написание: индекс их различает, и схлопнутое
// второе пропадало бы из поиска (дефект Н2). Правило одно на вызов и на слияние, остаётся
// первое написание.
test("дедуп алиасов одинаков в вызове и на слиянии", async () => {
  const added = await call({
    ...PROJECT,
    aliases: ["Пепси", "ПЕПСИ", "Сайёра", "Сайера"],
    title: "Дедуп",
    type: "contact",
  });
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(fields(added.file).aliases, ["Пепси", "Сайёра", "Сайера"]);

  const updated = await call({
    ...PROJECT,
    aliases: ["ПЕПСИ", "Сайера", "  Пепси  ", "Пепси  Геймер", "Пепси Геймер"],
    description: PROJECT.description,
    operation: "UPDATE",
    title: "Дедуп",
    type: "contact",
  });
  assert.equal(updated.ok, true, updated.error);
  assert.deepEqual(fields(added.file).aliases, [
    "Пепси",
    "Сайёра",
    "Сайера",
    "Пепси  Геймер",
  ]);
});
