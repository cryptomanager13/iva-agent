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
