/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Шов коммита памяти достаётся одним способом у обоих потребителей: обновлятор и меню
// обязаны работать на установке, где агентского дерева нет, поэтому пара коммитов
// достаётся динамически, а её отсутствие - не отказ чистки.
import "../lib/ts-esm-hooks.ts";
import { execFileSync } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { loadVaultPair } from "./vault-pair.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCHEMA = join(REPO, "vault-template", "schema.json");

function sh(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

/** Vault-репозиторий на один тест: стартовое состояние уже в истории. */
function makeVault(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-pair-"));
  t.after(() =>
    rmSync(dir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    }),
  );
  mkdirSync(join(dir, "cards", "notes"), { recursive: true });
  cpSync(SCHEMA, join(dir, "schema.json"));
  sh(["init", "-q", "-b", "main"], dir);
  sh(["config", "user.email", "pair@example.com"], dir);
  sh(["config", "user.name", "Pair"], dir);
  sh(["add", "-A"], dir);
  sh(["commit", "-q", "-m", "vault"], dir);
  return dir;
}

test("чистка после установки без агентского дерева идёт без пары коммитов", async (t) => {
  // Установка без `agent/`: модуль шва в дереве отсутствует, а чистку запускать надо.
  const broken = mkdtempSync(join(tmpdir(), "iva-broken-"));
  t.after(() => rmSync(broken, { force: true, recursive: true }));
  mkdirSync(join(broken, "scripts", "lib"), { recursive: true });
  cpSync(
    join(REPO, "scripts", "lib", "vault-pair.ts"),
    join(broken, "scripts", "lib", "vault-pair.ts"),
  );
  const loader = (await import(
    pathToFileURL(join(broken, "scripts", "lib", "vault-pair.ts")).href
  )) as typeof import("./vault-pair.ts");

  const pair = await loader.loadVaultPair(
    "update 9.9.9",
    join(broken, "vault"),
  );
  assert.equal(pair, null, "нет шва - нет пары, а не отказ");
});

test("живой шов приходит парой и коммитит обе половины под своим именем", async (t) => {
  const vault = makeVault(t);
  const pair = await loadVaultPair("menu", vault);
  assert.notEqual(pair, null);
  writeFileSync(
    join(vault, "cards", "notes", "правка.md"),
    "# Правка владельца\n",
  );
  await pair!.before();
  writeFileSync(join(vault, "cards", "notes", "итог.md"), "# Итог чистки\n");
  await pair!.after();

  const subjects = sh(["log", "--pretty=%s"], vault)
    .split("\n")
    .filter((subject) => subject !== "vault");
  assert.deepEqual(subjects, ["menu: vault cleanup", "menu: vault snapshot"]);
  assert.equal(
    readFileSync(join(vault, "cards", "notes", "правка.md"), "utf8"),
    "# Правка владельца\n",
  );
});
