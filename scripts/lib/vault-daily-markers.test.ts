/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Запись транскрипта — единственный шов, через который текст владельца и Ивы попадает в
// сырой день. Служебные отметки ночной сводки пишет только скилл; реплика, которая
// цитирует отметку, не должна сделать день «разобранным» или сдвинуть точку продолжения.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: fast-check печатает `{ seed: …, path: "…" }`; подставь их
// вторым аргументом fc.assert(prop, { seed, path }) — прогон повторится байт в байт.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { appendDaily } from "#lib/vault-daily.ts";
import { dayProgress } from "./rollup-days.ts";

function withVault(run: (vault: string) => void): void {
  const vault = mkdtempSync(join(tmpdir(), "iva-vault-daily-"));
  const previous = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = vault;
  try {
    run(vault);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previous;
    rmSync(vault, { force: true, recursive: true });
  }
}

test("a reply quoting the processed marker as its last line leaves the day undone", () => {
  withVault(() => {
    appendDaily("[text]", "как выглядит отметка конца дня?");
    const path = appendDaily(
      "[iva]",
      "Вот так, отдельной строкой:\n\n<!-- processed: 2026-01-01T04:00 -->",
    );
    const raw = readFileSync(path, "utf8");
    assert.deepEqual(dayProgress(raw), { done: false, through: null });
    // Текст цитаты сохранён для читателя, только уже не служебной строкой.
    assert.match(raw, /processed: 2026-01-01T04:00/u);
  });
});

test("a reply quoting a part marker is not a resume point", () => {
  withVault(() => {
    appendDaily("[text]", "важная встреча с Олегом");
    const path = appendDaily("[iva]", "<!-- processed-through: 23:41 -->");
    assert.equal(dayProgress(readFileSync(path, "utf8")).through, null);
  });
});

const markerLine = fc.constantFrom(
  "<!-- processed: 2026-01-01T04:00 -->",
  "<!-- processed-through: 12:05 -->",
  "<!-- processed-through: 23:59 -->",
  "---",
  "cards: 3",
  "",
);

test("no text written through the transcript seam ever reads as a service marker", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.array(fc.oneof(markerLine, fc.string({ maxLength: 30 })), {
          minLength: 1,
          maxLength: 6,
        }),
        { minLength: 1, maxLength: 4 },
      ),
      (replies) => {
        withVault(() => {
          let path = "";
          for (const lines of replies)
            path = appendDaily("[iva]", lines.join("\n"));
          assert.deepEqual(dayProgress(readFileSync(path, "utf8")), {
            done: false,
            through: null,
          });
        });
      },
    ),
    { numRuns: 200 },
  );
});
