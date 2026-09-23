/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";

import { claudeCommand } from "../agent/lib/claude-cli.ts";
import {
  CLAUDE_INSTALL_COMMAND,
  claudeInstallHint,
  servicePath,
} from "../packages/claude-command/index.ts";
import { claudeBinary } from "./lib/claude-cli-status.ts";

// Доктор и мастер обязаны говорить «CLI готов» ровно тогда, когда рантайм под юнитом его
// запустит: иначе владелец видит зелёный доктор и ENOENT на первом ходе.

const SEED = 20260923;

function fake(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

/** Получил ли процесс под этим окружением событие spawn. */
async function runtimeStarts(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const command = claudeCommand(env);
  if (command === null) return false;
  const [head, ...args] = command;
  return await new Promise<boolean>((resolve) => {
    const child = spawn(head, args, { env, stdio: "ignore" });
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
}

test(`the doctor finds claude exactly when the runtime under the unit starts it (seed ${SEED})`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-claude-command-"));
  const previousHome = process.env.HOME;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const absolute = fake(join(root, "abs", "claude-bin"));
  let run = 0;

  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("", "   ", absolute, `${absolute} --flag`, "claude"),
      fc.boolean(),
      fc.boolean(),
      async (configured, inLocalBin, inShellDir) => {
        const home = join(root, `home-${run}`);
        const shellDir = join(root, `shell-${run}`);
        run += 1;
        mkdirSync(join(home, ".local/bin"), { recursive: true });
        mkdirSync(shellDir, { recursive: true });
        if (inLocalBin) fake(join(home, ".local/bin/claude"));
        if (inShellDir) fake(join(shellDir, "claude"));
        process.env.HOME = home;

        const found =
          claudeBinary({ CLAUDE_COMMAND: configured, PATH: shellDir }) !== null;
        const started = await runtimeStarts({
          CLAUDE_COMMAND: configured,
          PATH: servicePath(dirname(process.execPath), home),
        });
        assert.equal(found, started);
        // Установка по подсказке (в ~/.local) находится без CLAUDE_COMMAND.
        if (configured.trim() === "" && inLocalBin) assert.equal(found, true);
      },
    ),
    { seed: SEED, numRuns: 60 },
  );
});

test("the install hint needs no root and names the service user", () => {
  const hint = claudeInstallHint();
  assert.doesNotMatch(hint, /npm install -g(?!.*--prefix)/u);
  assert.ok(hint.includes(userInfo().username), hint);
  assert.ok(hint.includes(CLAUDE_INSTALL_COMMAND), hint);
});
