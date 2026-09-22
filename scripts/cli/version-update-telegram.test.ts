/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import { createCliRuntime } from "./runtime.ts";
import { createVersionUpdateCommand } from "./version-update-command.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The half of the update the new version runs, cut down to what this test is
 * about: it moves the installation the way the real one does - complete, flip,
 * settle - and reports the outcome through the same file. Everything it stands in
 * for (npm, the probe, systemd) is proven elsewhere.
 */
const FINISH = `import { appendFileSync, rmSync, writeFileSync } from "node:fs";
const [home, name] = process.argv.slice(2);
appendFileSync(process.env.IVA_TEST_LOG, "handoff " + name + "\\n");
if (process.env.IVA_TEST_TAKE_JOB) rmSync(process.env.IVA_TEST_TAKE_JOB, { force: true });
if (process.env.IVA_TEST_FAIL) process.exit(1);
const { createVersionStore } = await import(process.env.IVA_TEST_STORE);
const store = createVersionStore(home);
const previous = store.currentName();
store.complete(name);
store.activate(name);
store.settle(name);
writeFileSync(
  process.env.IVA_UPDATE_OUTCOME,
  JSON.stringify({ status: "updated", version: name, previous, custom: "none", migrations: [], removed: [] }),
);
`;

type Call = { method: string; text: string };
type MockResponse = {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
};
type MockFetch = (url: string, init: { body: string }) => Promise<MockResponse>;
const mutableGlobal = globalThis as unknown as { fetch: MockFetch };

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "iva",
      GIT_AUTHOR_EMAIL: "iva@example.com",
      GIT_COMMITTER_NAME: "iva",
      GIT_COMMITTER_EMAIL: "iva@example.com",
    },
  }).trim();
}

type World = {
  readonly home: string;
  readonly log: string;
  readonly jobPath: string;
  /** The command on PATH that makes this checkout an installation. */
  readonly calls: Call[];
  /** Run `iva update --telegram-job job-1`, with the job file already in place. */
  run(env?: Record<string, string>): Promise<void>;
  lines(): string[];
  finals(): string[];
};

/**
 * An installation the version updater can really run against: a checkout with an
 * upstream to mirror, the job file the bridge leaves behind, and Telegram on a
 * leash. The updater's own process is this one, which is the point - the race
 * under test is between its event loop and the build it blocks it with.
 */
function world(
  t: TestContext,
  {
    provider = "codex",
    locale = "en",
  }: { provider?: string; locale?: string } = {},
): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-update-final-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "iva");
  const upstream = join(dir, "upstream.git");
  const log = join(dir, "order.log");
  writeFileSync(log, "");

  git(dir, ["init", "--bare", "--initial-branch=main", upstream]);
  mkdirSync(join(home, "scripts"), { recursive: true });
  writeFileSync(
    join(home, "package.json"),
    `${JSON.stringify({ name: "iva", version: "0.3.19", type: "module" }, null, 2)}\n`,
  );
  writeFileSync(join(home, "scripts/update-finish.ts"), FINISH);
  git(home, ["init", "--initial-branch=main"]);
  git(home, ["remote", "add", "origin", upstream]);
  git(home, ["config", "iva.updateBranch", "main"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-m", "release"]);
  git(home, ["push", "-q", "origin", "main"]);

  const dataDir = join(home, "data");
  const jobPath = join(dataDir, "update-jobs", "job-1.json");
  mkdirSync(dirname(jobPath), { recursive: true });
  writeFileSync(
    jobPath,
    JSON.stringify({
      chatId: 1,
      messageId: 100,
      locale,
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );

  const calls: Call[] = [];
  const previousFetch = mutableGlobal.fetch;
  const previousExitCode = process.exitCode;
  t.after(() => {
    mutableGlobal.fetch = previousFetch;
    process.exitCode = previousExitCode;
  });
  mutableGlobal.fetch = (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    const body = JSON.parse(init.body) as {
      text?: string;
      rich_message?: { markdown?: string };
    };
    // Финальные экраны обновления — rich: их текст лежит в rich_message.markdown.
    const text = body.rich_message?.markdown ?? body.text ?? "";
    calls.push({ method, text });
    // The one line the child process also writes to: the order between an edit
    // and the build that blocks this event loop is what the fix is about.
    appendFileSync(log, `${method} ${text}\n`);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }),
    });
  };

  const base = createCliRuntime(home);
  const runtime = {
    ...base,
    readEnv: () => ({
      AGENT_LANGUAGE: "en",
      TELEGRAM_BOT_TOKEN: "token",
      MODEL_PROVIDER: provider,
      CODEX_MODEL: "gpt-test",
    }),
    dataDirAbs: () => dataDir,
  };

  return {
    home,
    log,
    jobPath,
    calls,
    run: async (extra = {}) => {
      const command = createVersionUpdateCommand(
        {
          ...runtime,
          childEnv: {
            IVA_TEST_LOG: log,
            IVA_TEST_STORE: join(REPO, "scripts/lib/version-store.ts"),
            ...extra,
          },
        },
        { restartServices: () => {} },
      );
      await command.run(["--telegram-job", "job-1"]);
    },
    lines: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    finals: () =>
      calls
        .filter((call) => call.method === "editMessageText")
        .map((call) => call.text),
  };
}

const version = (iva: World): string =>
  `0.3.19-${git(iva.home, ["rev-parse", "HEAD"]).slice(0, 12)}`;

test("the build phase is on screen before the build blocks the loop", async (t) => {
  const iva = world(t);

  await iva.run();

  const lines = iva.lines();
  const phase = lines.findIndex((line) => /Building Iva/u.test(line));
  const handoff = lines.findIndex((line) => line.startsWith("handoff "));
  assert.notEqual(phase, -1, lines.join("\n"));
  assert.notEqual(handoff, -1, lines.join("\n"));
  // Fired off instead of awaited, the phase edit leaves this process while the
  // build holds the loop and lands after the final screen, overwriting it.
  assert.ok(phase < handoff, lines.join("\n"));
});

test("a successful update leaves the final word to the bridge", async (t) => {
  const iva = world(t);

  await iva.run();

  assert.deepEqual(
    iva.finals().filter((text) => /Iva updated/u.test(text)),
    [],
    "the dying process says nothing it cannot finish",
  );
  const stored: unknown = JSON.parse(readFileSync(iva.jobPath, "utf8"));
  const outcome = (stored as { outcome?: Record<string, unknown> }).outcome;
  assert.equal(outcome?.schema, "iva-update-outcome/v1");
  assert.equal(outcome?.status, "updated");
  assert.equal(outcome?.before, "0.3.19");
  assert.equal(outcome?.after, version(iva));
  assert.equal(outcome?.custom, "none");
  assert.equal(typeof outcome?.finishedAt, "string");
  // The job keeps the chat it has to answer.
  assert.equal((stored as { chatId?: unknown }).chatId, 1);
});

test("an update whose job file is gone reports the result itself", async (t) => {
  const iva = world(t);

  await iva.run({ IVA_TEST_TAKE_JOB: iva.jobPath });

  const final = iva.finals().at(-1) ?? "";
  assert.match(final, /Iva updated/u);
  assert.match(final, new RegExp(`0\\.3\\.19 → ${version(iva)}`, "u"));
  assert.equal(existsSync(iva.jobPath), false);
});

test("an update that is already current answers and drops its job", async (t) => {
  const iva = world(t);
  await iva.run();
  // Whatever the first run handed over is the bridge's; the second tap brings a
  // job of its own, and nothing is installed for it.
  rmSync(iva.jobPath, { force: true });
  writeFileSync(
    iva.jobPath,
    JSON.stringify({ chatId: 1, messageId: 101, locale: "en" }),
    { mode: 0o600 },
  );

  await iva.run();

  const final = iva.finals().at(-1) ?? "";
  assert.match(final, /Iva updated/u);
  assert.match(final, new RegExp(`${version(iva)} → ${version(iva)}`, "u"));
  assert.equal(existsSync(iva.jobPath), false);
  assert.deepEqual(readdirSync(dirname(iva.jobPath)), []);
});

test("a job that carries force rebuilds the version that already runs", async (t) => {
  const iva = world(t);
  await iva.run();
  const builtOnce = iva.lines().filter((line) => /Building Iva/u.test(line));
  rmSync(iva.jobPath, { force: true });
  writeFileSync(
    iva.jobPath,
    JSON.stringify({ chatId: 1, messageId: 101, locale: "en", force: true }),
    { mode: 0o600 },
  );

  await iva.run();

  // `/update --force` from the chat: the flag is in the job, not on the command
  // line, and the second run builds again instead of answering "current".
  const builtTwice = iva.lines().filter((line) => /Building Iva/u.test(line));
  assert.equal(builtOnce.length, 1, iva.lines().join("\n"));
  assert.equal(builtTwice.length, 2, iva.lines().join("\n"));
});

test("a failed update reports the failure and drops its job", async (t) => {
  const iva = world(t);

  await iva.run({ IVA_TEST_FAIL: "1" });

  const final = iva.finals().at(-1) ?? "";
  assert.match(final, /Couldn't build Iva/u);
  assert.match(final, /still running 0\.3\.19/u);
  assert.equal(existsSync(iva.jobPath), false);
  process.exitCode = 0;
});

test("an update that finds one already running answers and drops its job", async (t) => {
  const iva = world(t);
  const lock = join(iva.home, "data/update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );

  await iva.run();

  assert.match(iva.finals().at(-1) ?? "", /An update is already running/u);
  assert.equal(existsSync(iva.jobPath), false);
  assert.equal(
    iva.lines().some((line) => line.startsWith("handoff ")),
    false,
    "nothing was built",
  );
  process.exitCode = 0;
});

// Боевой путь апдейта — этот: чекаут без метки `.iva-dev` pipeline признаёт установкой.
// Префлайт, живущий только
// в legacy-обновлении, боевую установку не защищал: опечатка в MODEL_PROVIDER прогоняла
// fetch → build → restart, упиралась в health-check и возвращала «Couldn't build Iva»
// без единого слова о причине.
test("the managed update refuses an invalid MODEL_PROVIDER before it touches anything", async (t) => {
  const iva = world(t, { provider: "ollmaa" });

  await iva.run();

  const refusal = iva.finals().at(-1) ?? "";
  assert.match(refusal, /Fix MODEL_PROVIDER in \.env first \(iva config\)/u);
  assert.match(refusal, /"ollmaa"/u);
  // Список имён берётся у рантайма: вписанный сюда рукой устаревает на первом же вендоре.
  assert.ok(
    refusal.includes(MODEL_PROVIDER_NAMES.join(", ")),
    `${refusal} перечисляет имена рантайма`,
  );
  // Ни зеркала, ни хендоффа, ни версий: установка ровно та же, что была.
  assert.equal(
    iva.lines().some((line) => line.startsWith("handoff")),
    false,
  );
  assert.equal(existsSync(join(iva.home, "repo")), false);
  assert.equal(existsSync(join(iva.home, "versions")), false);
  // Джоб снят: сообщение получило финальный текст, ждать его больше некому.
  assert.equal(existsSync(iva.jobPath), false);
  assert.equal(process.exitCode, 1);
});

// Язык отказа — языка того, кто нажал /update, а не AGENT_LANGUAGE процесса CLI
// (в этом мире он "en"): в чат текст собирает репортер из своей copy по job.locale.
test("the managed refusal speaks the language of the chat that asked", async (t) => {
  const iva = world(t, { provider: "ollmaa", locale: "ru" });

  await iva.run();

  const refusal = iva.finals().at(-1) ?? "";
  assert.match(
    refusal,
    /Сначала почини MODEL_PROVIDER в \.env \(iva config\)/u,
  );
  assert.doesNotMatch(refusal, /Fix MODEL_PROVIDER/u);
});

test("every accepted provider name passes the managed preflight", async (t) => {
  for (const name of MODEL_PROVIDER_NAMES) {
    const iva = world(t, { provider: name });
    await iva.run();
    assert.equal(
      iva.lines().some((line) => line.startsWith("handoff")),
      true,
      name,
    );
  }
});

// Через весь путь до чата: репейр — единственное, что пользователю остаётся сделать,
// поэтому команда обязана доехать целиком, а не быть обрезанной хвостом отказа сборки.
test("a release that needs a newer updater says so in the chat, command intact", async (t) => {
  const iva = world(t, { locale: "ru" });
  writeFileSync(
    join(iva.home, "update-compat.json"),
    '{"minUpdater":"99.0.0"}\n',
  );
  git(iva.home, ["add", "-A"]);
  git(iva.home, ["commit", "-m", "release that needs a newer updater"]);
  git(iva.home, ["push", "-q", "origin", "main"]);

  await iva.run();

  const refusal = iva.finals().at(-1) ?? "";
  assert.match(
    refusal,
    /Ваша Iva \(\d+\.\d+\.\d+\) слишком старая, чтобы обновиться сама\./u,
  );
  assert.equal(
    refusal.includes(
      "curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash",
    ),
    true,
    refusal,
  );
  assert.match(refusal, /Данные и \.env остаются на месте\./u);
  assert.doesNotMatch(refusal, /Повторить: \/update/u);
  // Ничего не собрано и не переключено.
  assert.equal(
    iva.lines().some((line) => line.startsWith("handoff ")),
    false,
    "nothing was built",
  );
  assert.equal(existsSync(join(iva.home, "current")), false);
  assert.equal(existsSync(iva.jobPath), false);
  assert.equal(process.exitCode, 1);
});
