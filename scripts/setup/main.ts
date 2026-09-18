// Iva interactive setup: writes .env.
// Step-by-step guide with per-key instructions, live validation, and a loop —
// the script will NOT exit until every required secret is entered.
// Этот файл только подключает живой мир: readline, stdout, fetch, пути к .env и
// проверку портов. Сам мастер — scripts/setup/wizard.ts, его диалог — dialog.ts.
import { createInterface } from "node:readline/promises";
import { createReadStream, existsSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { defaultChecker } from "../lib/ports.ts";
import {
  authFilePath,
  readAuth,
  runDeviceCodeLogin,
  runBrowserLogin,
  listCodexModels,
} from "../lib/codex-oauth.ts";
import { validateModelSelection } from "../lib/model-validation.ts";
import { fetchModels } from "../lib/model-catalog.ts";
import { isEntrypoint } from "../lib/version-layout.ts";
import { dataDirOf, loadEnvFile, writeEnvFile } from "./config-file.ts";
import { createDialog } from "./dialog.ts";
import { createNetworkChecks } from "./network.ts";
import { C, type Env, type SetupContext } from "./steps.ts";
import { abortReason, runWizard } from "./wizard.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
// The configuration this run starts from. Normally the live .env of the installation;
// `IVA_CONFIG_INPUT` points it elsewhere, which is what lets the wizard be run against a
// fixture instead of the machine's own configuration - the reason its "already configured"
// branch went untested until it shipped a bug (issue #161). Symmetric with the output side
// below, and the two are independent: reading a fixture does not decide where it writes.
const SOURCE_ENV_PATH = process.env.IVA_CONFIG_INPUT
  ? resolve(process.env.IVA_CONFIG_INPUT)
  : join(ROOT, ".env");
// `iva config` stages a complete candidate outside the live .env, then applies it
// transactionally. Direct setup/install keeps the historical live path.
const ENV_PATH = process.env.IVA_CONFIG_OUTPUT
  ? resolve(process.env.IVA_CONFIG_OUTPUT)
  : SOURCE_ENV_PATH;
const STAGING_CONFIG = ENV_PATH !== SOURCE_ENV_PATH;
const dataDirAbs = (env: Env | null | undefined) => dataDirOf(ROOT, env);

// Read from tty even when launched via `curl | bash`: there stdin is the script itself,
// so the answers have to come from the terminal. Where there is no controlling terminal
// at all (a plain spawn without a pty), opening /dev/tty fails with ENXIO and used to kill
// the wizard on an unhandled error event - read whatever stdin is instead. Opened with
// openSync, because a createReadStream failure arrives asynchronously and cannot be caught
// here.
function promptInput(): NodeJS.ReadableStream {
  if (process.stdin.isTTY) return process.stdin;
  try {
    return createReadStream("", { fd: openSync("/dev/tty", "r") });
  } catch {
    return process.stdin;
  }
}
const rl = createInterface({ input: promptInput(), output: process.stdout });

const dialog = createDialog(
  {
    question: (prompt) => rl.question(prompt),
    print: (...args) => console.log(...args),
    write: (text) => {
      process.stdout.write(text);
    },
  },
  defaultChecker(),
);

export async function main(entryUrl = import.meta.url): Promise<void> {
  if (!isEntrypoint(entryUrl)) return;
  await runWizard({
    ctx: createSetupContext(),
    setLang: dialog.setLang,
    readExisting: () => loadEnvFile(SOURCE_ENV_PATH),
    codexLoggedIn: (existing) => existsSync(authFilePath(dataDirAbs(existing))),
    staging: STAGING_CONFIG,
    closeInput: () => rl.close(),
  });
}

/** Контекст мастера: живой диалог, сеть и запись .env — то, что шаги получают параметром. */
function createSetupContext(): SetupContext {
  return {
    ...dialog,
    envValue: (name) => process.env[name],
    dataDirAbs,
    readAuth,
    listCodexModels,
    runBrowserLogin,
    runDeviceCodeLogin,
    fetchModels,
    validateModelSelection,
    writeEnv: (out) => writeEnvFile(ENV_PATH, out, droppedKey),
    ...createNetworkChecks({
      fetchFn: fetch,
      t: dialog.t,
      print: dialog.print,
    }),
  };
}

function droppedKey(key: string): void {
  console.log(
    `${C.y}  ⚠ ${dialog.t(
      `Dropped ${key} from the existing .env: the service and the iva command would read it differently. Set it again by hand if you need it.`,
      `${key} не перенесён из существующего .env: сервис и команда iva прочитали бы его по-разному. Задайте его заново вручную, если он нужен.`,
    )}${C.x}`,
  );
}

void main().catch((error) => {
  console.error(
    `${C.r}${dialog.t("Setup aborted:", "Настройка прервана:")}${C.x}`,
    abortReason(error),
  );
  process.exit(1);
});
