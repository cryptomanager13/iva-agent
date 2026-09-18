/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns the registrations. */
// Чтение и запись .env мастером во временной папке.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  dataDirOf,
  loadEnvFile,
  orderedKeys,
  writeEnvFile,
} from "./config-file.ts";

const SEED = 20260918;

function folder(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "iva-setup-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("load: a missing .env is an empty configuration", async (t) => {
  assert.deepEqual(await loadEnvFile(join(folder(t), "absent.env")), {});
});

test("load: failure — any other read error is not swallowed", async (t) => {
  const path = join(folder(t), "dir.env");
  mkdirSync(path);
  await assert.rejects(loadEnvFile(path), { code: "EISDIR" });
});

test("write: known keys in their order, foreign keys after, a value .env cannot hold is dropped by name", async (t) => {
  const path = join(folder(t), ".env");
  const dropped: string[] = [];
  await writeEnvFile(
    path,
    {
      MY_EXTRA: "1",
      IVA_PORT: "8723",
      AGENT_LANGUAGE: "en",
      BROKEN: "line\nbreak",
    },
    (key) => dropped.push(key),
  );
  assert.equal(
    readFileSync(path, "utf8"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\nMY_EXTRA=1\n",
  );
  assert.deepEqual(dropped, ["BROKEN"]);
});

test("orderedKeys skips known keys that are absent", () => {
  assert.deepEqual(orderedKeys({ ZED: "1", MODEL_PROVIDER: "ollama" }), [
    "MODEL_PROVIDER",
    "ZED",
  ]);
});

const key = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/u);
const safeValue = fc.stringMatching(/^[A-Za-z0-9._:/@,-]{0,24}$/u);

test(`write then load returns the same configuration (seed ${SEED})`, async (t) => {
  const root = folder(t);
  let n = 0;
  await fc.assert(
    fc.asyncProperty(fc.dictionary(key, safeValue), async (out) => {
      const path = join(root, `${n++}.env`);
      const dropped: string[] = [];
      await writeEnvFile(path, out, (k) => dropped.push(k));
      assert.deepEqual(dropped, []);
      assert.deepEqual(await loadEnvFile(path), { ...out });
    }),
    { seed: SEED, numRuns: 100 },
  );
});

test("dataDirOf: the data folder of the configuration, under the install root", () => {
  assert.equal(
    dataDirOf("/iva", { ASSISTANT_DATA_DIR: "state" }),
    "/iva/state",
  );
  assert.equal(dataDirOf("/iva", null), "/iva/data");
});
