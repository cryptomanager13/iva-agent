import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statfsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
// CLI обязан грузиться без authored tree и без "#lib"-маппинга
// (scripts/cli/entrypoints.test.ts), поэтому run-status и telegram-queue
// подгружаются динамически в самой проверке, а здесь — только типы.
import type { listChatStatuses } from "../../agent/lib/run-status.ts";
import type { TelegramQueueDocument } from "../lib/telegram-queue.ts";
import { pluginDirectory, pluginMount } from "../lib/plugin-build.ts";
import { tryLoadPluginCore } from "../lib/plugin-core.ts";
import { leftoverPluginDirs, pluginReadProblem } from "./plugin-cli-context.ts";
import {
  installedPluginUnits,
  mcpUnitName,
  serviceUnitName,
} from "../lib/plugin-units.ts";
import { LEGACY_BRAIN_UNITS } from "../lib/legacy-memory-units.ts";
import { classifyAgentListeners } from "../lib/listener-security.ts";
import { readMemoryMaintenanceReport } from "../lib/memory-maintenance.ts";
import {
  CATALOG,
  catalogProvider,
  providerEnvKeys,
} from "../lib/model-catalog.ts";
import { claudeStatus } from "../lib/claude-cli-status.ts";
import { classifyRoot } from "../lib/version-layout.ts";
import {
  acquireUpdateLock,
  createVersionStore,
  KEEP,
} from "../lib/version-store.ts";
import { hasEmbeddingSource } from "../lib/memory-mode.ts";
import { ambiguousEnvLines } from "../lib/env-file.ts";
// `import type` стирается при компиляции, значения authored tree грузятся динамически
// внутри вызова: `iva doctor` работает и на установке, где agent/ нет
// (scripts/authored-tree-guard.test.ts).
import type { JobFact } from "#lib/job-facts.ts";
import type { OpenFailure } from "#lib/open-failures.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";
import { resolveVaultDir } from "../../packages/vault-dir/index.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

type DoctorDependencies = {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly exit?: (code: number) => unknown;
  readonly log?: (...args: unknown[]) => void;
  readonly nodeVersion?: string;
  readonly telegramInboxFile?: string;
  readonly telegramQueueFile?: string;
  readonly listChatStatusesImpl?: typeof listChatStatuses;
};

type RollupEntry = {
  readonly lastSuccessAt?: unknown;
  readonly lastExitCode?: unknown;
};

type RollupStatus = Record<string, RollupEntry | null | undefined>;

export interface ScheduleFactsReport {
  readonly lastRuns: readonly string[];
  readonly openFailures: readonly OpenFailure[];
  /** Строки таблицы: пакет diagnose печатает по ним хвосты незакрытых провалов. */
  readonly facts: readonly JobFact[];
}

/**
 * Модуль authored tree не загрузился: дерева нет или оно недописано (ADR-0003). Это не
 * поломка таблицы фактов — про само дерево доктор говорит отдельной строкой, поэтому
 * раздел расписаний в этом случае молчит, как и раздел напоминаний ниже.
 */
export function authoredTreeMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (
    code !== "ERR_MODULE_NOT_FOUND" &&
    code !== "ERR_PACKAGE_IMPORT_NOT_DEFINED"
  )
    return false;
  // Любая ERR_MODULE_NOT_FOUND — это ещё и пропавший локальный пакет (`packages/…`):
  // счесть его отсутствием дерева значит промолчать о поломке (T30 №9). Своя ошибка
  // называет `#lib/`-алиас или путь в `agent/`; если каталога дерева нет вовсе — тоже она.
  const message = error instanceof Error ? error.message : String(error);
  // Своя ошибка называет `#lib/`-алиас или путь в `agent/`; чужой пакет (`packages/…`)
  // сюда не попадает и доктор о нём предупреждает.
  return /#lib\/|#evals\/|agent[\\/]/u.test(message);
}

/**
 * Раздел «расписания» по таблице фактов (T20 п.5): последний запуск каждого имени и
 * незакрытые провалы. Status-файл ниже отвечает только за «последний успех» и гварды,
 * поэтому история берётся отсюда. Пульс минутного диспетчера говорит раздел напоминаний
 * этой же команды — второго источника об одном и том же mtime здесь нет.
 */
export async function scheduleFactsReport(
  dataDirectory: string,
  now: number,
): Promise<ScheduleFactsReport> {
  const { jobFactsFile, latestFact, readFactsSync } =
    await import("#lib/job-facts.ts");
  const { openJobFailures } = await import("#lib/open-failures.ts");
  const { SCHEDULE_CRON } = await import("#lib/schedule-table.ts");
  const facts = readFactsSync(jobFactsFile(dataDirectory));
  const names = [
    ...new Set([...Object.keys(SCHEDULE_CRON), ...facts.map((f) => f.name)]),
  ].sort();
  const lastRuns: string[] = [];
  for (const name of names) {
    const latest: JobFact | null = latestFact(facts, name);
    if (!latest) continue;
    const when = new Date(latest.finishedAt).toISOString();
    lastRuns.push(
      latest.ok
        ? `${name}: ok, ${when}`
        : `${name}: провал (${latest.error ?? "без причины"}), ${when}`,
    );
  }
  return { lastRuns, openFailures: openJobFailures(facts, now), facts };
}

/** Сколько ждём `/health` прокси: он на loopback, и медленный ответ — уже симптом. */
const HEALTH_TIMEOUT_MS = 1500;
const WORKFLOW_RUNNING_LIMIT = 5;

/**
 * id строки напоминания в выводе доктора и в пакете diagnose — короткий хеш, а не id. Имя
 * строки задаёт владелец, и текстовый слаг («напомни-про-подарок») увёз бы его слова в
 * issue; сверить же строку можно и по хешу: sha256 от id, первые восемь знаков.
 */
export function reminderIdHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

/**
 * Код ошибки вместо её текста. В `error` строки напоминания апстрим кладёт тело ответа
 * Telegram (`scripts/lib/telegram-send.ts`), а в теле может лежать текст самого напоминания
 * — владельческий. Кода хватает, чтобы отличить отказ доступа от лимита и от 5xx; имени
 * операции и статуса достаточно, всё остальное в вывод доктора и пакет не едет.
 */
export function errorCode(raw: string): string {
  const status = /\b[1-5]\d{2}\b/u.exec(raw)?.[0] ?? "";
  const name = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}/u.exec(raw.trim())?.[0] ?? "";
  const code = [name, status].filter(Boolean).join(" ");
  return code.length > 0 ? code : "error text omitted";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "unknown error";
}

type WorkflowStoreReport = {
  readonly runs: Readonly<Record<string, number>>;
  readonly hookFiles: number;
  readonly unreadable: number;
};

function workflowStoreReport(root: string): WorkflowStoreReport {
  const store = join(root, ".eve", ".workflow-data");
  const entries = (directory: string) => {
    try {
      return readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const runs: Record<string, number> = {};
  let unreadable = 0;
  for (const entry of entries(join(store, "runs"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = join(store, "runs", entry.name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const status = (parsed as { status?: unknown } | null)?.status;
      if (typeof status !== "string" || status.length === 0) {
        unreadable++;
        continue;
      }
      runs[status] = (runs[status] ?? 0) + 1;
    } catch {
      unreadable++;
    }
  }
  const hookFiles = entries(join(store, "hooks")).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  ).length;
  return { runs, hookFiles, unreadable };
}

function formatWorkflowStore(report: WorkflowStoreReport): string {
  const statuses = Object.entries(report.runs).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const total = statuses.reduce((count, [, value]) => count + value, 0);
  const details =
    statuses.length === 0
      ? ""
      : ` (${statuses.map(([status, count]) => `${status} ${count}`).join(", ")})`;
  const unreadable =
    report.unreadable > 0 ? `, ${report.unreadable} unreadable` : "";
  return `${total} runs${details}; ${report.hookFiles} hook files${unreadable}`;
}

/** Free bytes in the short units used by the installation report. */
function formatFreeSpace(bytes: number): string {
  const mb = 1024 ** 2;
  const gb = 1024 ** 3;
  return bytes >= gb
    ? `${(bytes / gb).toFixed(1)} GB`
    : `${Math.round(bytes / mb)} MB`;
}

/** Счётчики вердиктов одного прогона: по ним считается сводка и exit-код. */
type DoctorCounts = {
  ok: number;
  warn: number;
  fix: number;
  bad: number;
};

/**
 * Печать и счёт вердиктов — единственное место, где меняются счётчики прогона. Секции
 * получают его вместе с путями, переменных, замкнутых из `cmdDoctor`, больше нет. Печать и
 * счёт разделены там, где доктор печатает одну строку на несколько фактов (незакрытые
 * провалы, асимметричные таймеры): сводка считает вердикт по факту, а не по числу строк,
 * и обязана остаться прежней.
 */
type DoctorReporter = {
  /** Напечатать строку и посчитать вердикт. */
  ok(message: string): void;
  warn(message: string): void;
  fail(message: string): void;
  /** Починка: счётчик `fixed` без строки. */
  fix(): void;
  /** Печать без счёта — вердикт считает вызывающий. */
  printOk(message: string): void;
  printWarn(message: string): void;
  /** Счёт без печати. */
  countOk(): void;
  countWarn(): void;
  report(): DoctorCounts;
};

/** Пути, runtime и зависимости прогона: снимок .env и каталогов на все секции. */
type DoctorRun = {
  readonly root: string;
  readonly envPath: string;
  readonly unitDir: string;
  readonly npm: string;
  readonly services: readonly string[];
  readonly brainService: string;
  readonly brainTimer: string;
  readonly timers: readonly string[];
  readonly defaultPort: string;
  readonly colors: CliRuntime["C"];
  readonly run: CliRuntime["run"];
  readonly cap: CliRuntime["cap"];
  readonly hasSystemd: CliRuntime["hasSystemd"];
  readonly systemd: CliRuntime["systemd"];
  readonly readEnv: CliRuntime["readEnv"];
  readonly env: ReturnType<CliRuntime["readEnv"]>;
  readonly dataDirectory: string;
  readonly telegramInboxFile: string;
  readonly telegramQueueFile: string;
  readonly ensureAssistantBearer: SystemdLifecycle["ensureAssistantBearer"];
  readonly writeUnits: SystemdLifecycle["writeUnits"];
  readonly activateUnits: SystemdLifecycle["activateUnits"];
  readonly migrateEnv: SystemdLifecycle["migrateEnv"];
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly exit: (code: number) => unknown;
  readonly log: (...args: unknown[]) => void;
  readonly nodeVersion: string;
  readonly listChatStatuses: typeof listChatStatuses | undefined;
  /** Раскладка установки: заполняет секция версий, читает раздел плагинов (ADR-0009). */
  install: ReturnType<typeof classifyRoot> | null;
};

type DoctorContext = DoctorReporter & DoctorRun;

export function createDoctorCommand(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DoctorDependencies = {},
) {
  return async function cmdDoctor(): Promise<void> {
    // Порядок тот же, что был в монолитном теле: bearer до снимка .env, чтобы мастер
    // ключей видел уже записанный bearer.
    const bearerChanged = systemdLifecycle.ensureAssistantBearer();
    const ctx = createDoctorContext(runtime, systemdLifecycle, dependencies);
    if (bearerChanged) ctx.fix();

    checkNode(ctx);
    if (await checkEnvFile(ctx)) checkEnvOptions(ctx);
    checkBuild(ctx);
    ctx.install = checkVersionState(ctx);
    await checkScheduleFacts(ctx);

    if (!ctx.hasSystemd()) {
      ctx.printWarn(
        "systemd unavailable (not Linux) — skipping service and timer checks",
      );
      return finishDoctor(ctx);
    }

    checkWorkflowStore(ctx);
    checkUnits(ctx);
    checkServices(ctx, bearerChanged);
    await checkListener(ctx);
    checkTimers(ctx);
    checkNightlyServices(ctx);
    checkRollupStatus(ctx);
    await checkReminders(ctx);
    await checkBridge(ctx);
    const vaultPath = checkVault(ctx);
    checkMaintenance(ctx, vaultPath);
    return finishDoctor(ctx);
  };
}

/** Собирает контекст прогона: печать со счётом плюс один снимок окружения и путей. */
function createDoctorContext(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DoctorDependencies,
): DoctorContext {
  return {
    ...createDoctorReporter(runtime),
    ...createDoctorRun(runtime, systemdLifecycle, dependencies),
  };
}

/** Печать и счёт вердиктов: счётчики живут внутри отчёта, наружу торчит только сводка. */
function createDoctorReporter(runtime: CliRuntime): DoctorReporter {
  const { ok, warn, bad } = runtime;
  const counts: DoctorCounts = { ok: 0, warn: 0, fix: 0, bad: 0 };
  return {
    ok: (message) => {
      ok(message);
      counts.ok++;
    },
    warn: (message) => {
      warn(message);
      counts.warn++;
    },
    fail: (message) => {
      bad(message);
      counts.bad++;
    },
    fix: () => {
      counts.fix++;
    },
    printOk: ok,
    printWarn: warn,
    countOk: () => {
      counts.ok++;
    },
    countWarn: () => {
      counts.warn++;
    },
    report: () => ({ ...counts }),
  };
}

/** Разрешённые необязательные зависимости прогона: тесты подставляют их вместо времени и выхода. */
type DoctorDeps = Pick<
  DoctorRun,
  "now" | "sleep" | "exit" | "log" | "nodeVersion" | "listChatStatuses"
>;

function resolveDoctorDeps(dependencies: DoctorDependencies): DoctorDeps {
  return {
    now: dependencies.now ?? Date.now,
    sleep:
      dependencies.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    exit: dependencies.exit ?? ((code: number) => process.exit(code)),
    log: dependencies.log ?? ((...args: unknown[]) => console.log(...args)),
    nodeVersion: dependencies.nodeVersion ?? process.versions.node,
    listChatStatuses: dependencies.listChatStatusesImpl,
  };
}

/** Пути, runtime и зависимости прогона: .env читается один раз и после записи bearer. */
function createDoctorRun(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DoctorDependencies,
): DoctorRun {
  const {
    ROOT,
    ENV_PATH,
    UNIT_DIR,
    NPM,
    SERVICES,
    BRAIN_SERVICE,
    BRAIN_TIMER,
    TIMERS,
    DEFAULT_PORT,
    C,
    run,
    cap,
    hasSystemd,
    systemd,
    readEnv,
    dataDirAbs,
  } = runtime;
  const { ensureAssistantBearer, writeUnits, activateUnits, migrateEnv } =
    systemdLifecycle;
  // Одна выкладка данных на весь прогон: каталог не меняется под ногами, а
  // каждый лишний вызов — это ещё одно чтение .env ради того же ответа.
  const env = readEnv();
  const dataDirectory = dataDirAbs(env);
  const telegramInboxFile =
    dependencies.telegramInboxFile ??
    join(dataDirectory, "telegram-inbox.json");
  const telegramQueueFile =
    dependencies.telegramQueueFile ??
    join(dataDirectory, "telegram-queue.json");
  return {
    ...resolveDoctorDeps(dependencies),
    root: ROOT,
    envPath: ENV_PATH,
    unitDir: UNIT_DIR,
    npm: NPM,
    services: SERVICES,
    brainService: BRAIN_SERVICE,
    brainTimer: BRAIN_TIMER,
    timers: TIMERS,
    defaultPort: DEFAULT_PORT,
    colors: C,
    run,
    cap,
    hasSystemd,
    systemd,
    readEnv,
    env,
    dataDirectory,
    telegramInboxFile,
    telegramQueueFile,
    ensureAssistantBearer,
    writeUnits,
    activateUnits,
    migrateEnv,
    install: null,
  };
}

// 1. Node ≥24
function checkNode(ctx: DoctorContext): void {
  const major = parseInt(ctx.nodeVersion.split(".")[0], 10);
  if (major >= 24) {
    ctx.ok(`Node ${ctx.nodeVersion}`);
  } else {
    ctx.fail(`Node ${ctx.nodeVersion} < 24 — upgrade: nvm install 24`);
  }
}

/**
 * 2. .env и обязательные ключи — та же REQUIRED-логика, что в scripts/setup/wizard.ts.
 * True возвращается, когда .env есть: только тогда имеет смысл необязательный хвост
 * раздела (checkEnvOptions), как и было в монолите.
 */
async function checkEnvFile(ctx: DoctorContext): Promise<boolean> {
  if (!existsSync(ctx.envPath)) {
    ctx.fail(".env missing — run: iva config");
    return false;
  }
  // Имя провайдера и его обязательные ключи — из того же каталога, что кнопки /model
  // и мастер: доктор не может принять имя, которого не примет рантайм (перечень имён
  // сверяет scripts/lib/model-catalog.test.ts с копией в agent/lib/model-provider.ts).
  // Неизвестное значение — отказ, а не диагностика ollama: рантайм на нём не стартует.
  const rawProvider = ctx.env.MODEL_PROVIDER ?? "ollama";
  const provider = catalogProvider(rawProvider);
  if (!provider) {
    ctx.fail(
      `Invalid MODEL_PROVIDER ${JSON.stringify(rawProvider)}; expected one of: ${Object.keys(CATALOG).join(", ")} — run: iva config`,
    );
    return true;
  }
  // codex — доступ по OAuth-токену (data/codex-auth.json), у остальных — ключ в .env.
  const required = [
    ...providerEnvKeys(provider),
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
    "ASSISTANT_BEARER",
  ];
  const missing = required.filter((key) => !(ctx.env[key] || "").trim());
  if (
    provider.auth === "oauth" &&
    !existsSync(join(ctx.dataDirectory, "codex-auth.json"))
  )
    missing.push("OpenAI sign-in (iva login)");
  if (!missing.length) {
    ctx.ok(`.env filled in (provider: ${rawProvider})`);
  } else {
    ctx.fail(
      `.env incomplete, missing: ${missing.join(", ")} — run: iva config`,
    );
  }
  // Вендора без ключа в .env доктор проверяет там же, где живёт его вход: в чужом CLI
  // на этой же машине. Молчать об этом значило бы объявить .env здоровым перед
  // отказом агента на старте.
  if (provider.auth === "cli") await checkClaudeCli(ctx);
  return true;
}

/** Статус Claude Code CLI: имя плана при входе и подсказка вместо него при отказе. */
async function checkClaudeCli(ctx: DoctorContext): Promise<void> {
  // PATH берём у процесса, значения — из .env: юнит несёт EnvironmentFile, а бинарь
  // ищется по PATH сервиса, не по строке в файле.
  const status = await claudeStatus({ ...process.env, ...ctx.env });
  if (status.ready) {
    ctx.ok(`Claude Code CLI: signed in (plan: ${status.plan || "unnamed"})`);
    return;
  }
  ctx.fail(status.hint);
}

/** Хвост раздела .env: двусмысленные строки, миграция порта, необязательные поиск и память. */
function checkEnvOptions(ctx: DoctorContext): void {
  // Значение вне безопасного подмножества сервис и команда могут прочитать
  // по-разному: юнит несёт `EnvironmentFile=`, а CLI читает тем же parseEnv, что и
  // `node --env-file`. Разбирается СЫРОЙ текст файла, а не `env`: `parseEnv` уже
  // обрезал бы `KEY=ab#cd` до `ab`, и главный случай стал бы невидимым. Имена
  // называем, значения - никогда: в них секреты.
  const ambiguous = ambiguousEnvLines(readFileSync(ctx.envPath, "utf8")).map(
    ({ key, problem }) => `${key} (${problem})`,
  );
  if (ambiguous.length) {
    // Печать без счёта: строка одна на список, вердикт по ней не считается (как и раньше).
    ctx.printWarn(
      `.env lines the service and the CLI may read differently: ${ambiguous.join(", ")} — re-enter them: iva config`,
    );
  }
  // old .env without IVA_PORT (or with :3000) — migrate right here
  if (ctx.migrateEnv()) ctx.fix();
  // voice is optional: without the key voice notes are saved but not transcribed
  if (!(ctx.env.DEEPGRAM_API_KEY || "").trim())
    ctx.warn(
      "voice notes are not transcribed (no DEEPGRAM_API_KEY) — /menu → 🎤 Voice",
    );
  // web search is optional; check the key of the SELECTED provider (SEARCH_PROVIDER)
  const searchKey: Record<string, string> = {
    tavily: "TAVILY_API_KEY",
    brave: "BRAVE_API_KEY",
    exa: "EXA_API_KEY",
    parallel: "PARALLEL_API_KEY",
  };
  const searchProvider = (ctx.env.SEARCH_PROVIDER || "tavily")
    .trim()
    .toLowerCase();
  const selectedSearchKey = searchKey[searchProvider] || searchKey.tavily;
  if (!(ctx.env[selectedSearchKey] || "").trim()) {
    ctx.warn(
      `web_search: SEARCH_PROVIDER=${searchProvider}, but ${selectedSearchKey} is not set — search won't work (iva config)`,
    );
  } else {
    ctx.ok(`web_search: ${searchProvider}`);
  }
  // memory_search: hybrid mode needs one embedding key; base (grep) needs nothing.
  const memoryMode = (ctx.env.MEMORY_SEARCH_MODE || "grep")
    .trim()
    .toLowerCase();
  if (memoryMode === "hybrid" && !hasEmbeddingSource(ctx.env)) {
    ctx.warn(
      "memory_search: MEMORY_SEARCH_MODE=hybrid but no JINA_API_KEY/DEEPINFRA_API_KEY/MEMORY_EMBED_URL — falls back to BM25",
    );
  } else {
    ctx.ok(`memory_search: ${memoryMode}`);
  }
}

// 3. Build
function checkBuild(ctx: DoctorContext): void {
  if (existsSync(join(ctx.root, ".output/server/index.mjs"))) {
    ctx.ok("Build in place (.output)");
    return;
  }
  ctx.warn(".output missing — building…");
  if (ctx.run(ctx.npm, ["run", "build"]).status === 0) {
    ctx.ok("Built");
    ctx.fix();
  } else {
    ctx.fail("Build failed");
  }
}

/**
 * Состояние установки версий: незавершённый апдейт и уборка лишних версий. Возвращает
 * раскладку корня — её ещё спрашивает раздел плагинов (`codeBuiltIntoVersion`).
 */
function checkVersionState(
  ctx: DoctorContext,
): ReturnType<typeof classifyRoot> {
  // An update whose flip landed but whose restart or migrations did not: the
  // daily check cannot see it, because upstream and the active version agree.
  const install = classifyRoot(ctx.root);
  const store = createVersionStore(install.home);
  const active = store.currentName();
  if (active) {
    try {
      if (store.settled() !== active) {
        ctx.warn(`update to ${active} never finished — run: iva update`);
      }
    } catch {
      // Corrupt state is reported by the version cleanup below, which reads
      // the same file first and deletes nothing when it cannot be trusted.
    }
  }

  if (install.kind === "version" && active) {
    const lock = acquireUpdateLock(store.layout.data);
    if (!lock) {
      ctx.warn("update in progress — version cleanup skipped");
    } else {
      try {
        const leftovers = store.sweep();
        const removed = store.gc(KEEP);
        const gone = [...leftovers, ...removed];
        if (gone.length > 0) {
          ctx.ok(`removed ${gone.join(", ")}`);
          ctx.fix();
        }
        const free = statfsSync(store.layout.versions);
        const freeBytes = free.bavail * free.bsize;
        ctx.ok(
          `versions on disk: ${store.list().length} (current ${active}, rollback ${store.previousName() ?? "none"}) — ${formatFreeSpace(freeBytes)} free`,
        );
      } catch (error) {
        ctx.fail(`version cleanup failed: ${String(error)}`);
      } finally {
        lock.release();
      }
    }
  }
  return install;
}

/**
 * Таблица фактов (T20 §5): последний запуск каждого имени и незакрытые провалы.
 * Стоит выше раннего выхода systemd: jobs.json есть на любой установке, и на
 * macOS это единственный след сломанного расписания.
 * Историю держит jobs.json, rollup-status.json — только «последний успех» и гварды;
 * пульс минутного диспетчера говорит раздел напоминаний ниже.
 */
async function checkScheduleFacts(ctx: DoctorContext): Promise<void> {
  try {
    const report = await scheduleFactsReport(ctx.dataDirectory, ctx.now());
    for (const line of report.lastRuns) {
      if (line.includes(": провал")) {
        ctx.warn(`расписание ${line} — check: iva doctor, iva jobs ack <name>`);
      } else {
        ctx.ok(`расписание ${line}`);
      }
    }
    for (const failure of report.openFailures)
      // Печать на каждый провал, счёт — один на весь список: сводка считает раздел,
      // а не число строк (поведение монолита сохранено).
      ctx.printWarn(
        `незакрытый провал: ${failure.name} (${failure.reason}) — закрыть: iva jobs ack ${failure.name}`,
      );
    if (report.openFailures.length > 0) ctx.countWarn();
  } catch (error) {
    if (!authoredTreeMissing(error)) {
      ctx.warn(
        `расписания: таблица фактов не читается — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function checkWorkflowStore(ctx: DoctorContext): void {
  try {
    const workflow = workflowStoreReport(ctx.root);
    const running = workflow.runs.running ?? 0;
    const report = `workflow store: ${formatWorkflowStore(workflow)}`;
    if (running > WORKFLOW_RUNNING_LIMIT) {
      // The remedy is named here: without it the owner's agent reads «exceeds 5»,
      // finds no way to cancel a run, and reports «no standard means» (16.09.2026).
      ctx.warn(
        `${report} — running count ${running} exceeds ${WORKFLOW_RUNNING_LIMIT}; runs the agent no longer serves are stale, not live: iva reset quarantines them and restarts`,
      );
    } else {
      ctx.ok(report);
    }
  } catch (error) {
    ctx.warn(
      `workflow store unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// 4. Units installed
function checkUnits(ctx: DoctorContext): void {
  const present =
    existsSync(ctx.unitDir) &&
    readdirSync(ctx.unitDir).some((file) =>
      /^iva.*\.(service|timer)$/.test(file),
    );
  if (!present) {
    ctx.warn("systemd units not installed — installing…");
    try {
      ctx.writeUnits();
      ctx.activateUnits();
      ctx.ok("Units installed, enabled and active");
      ctx.fix();
    } catch (error) {
      ctx.fail((error as { message: string }).message);
    }
  } else {
    try {
      ctx.writeUnits(); // refresh: Environment=PORT syncs with the current IVA_PORT (eliminates drift)
      ctx.ok("systemd units installed (refreshed)");
    } catch (error) {
      ctx.fail((error as { message: string }).message);
    }
  }
}

/** 5. Services active плюс перезапуск, нужный только что записанному внутреннему bearer. */
function checkServices(ctx: DoctorContext, bearerChanged: boolean): void {
  for (const service of ctx.services) {
    if (ctx.systemd.isEnabled(service) && ctx.systemd.isActive(service)) {
      ctx.ok(`${service} enabled and active`);
      continue;
    }
    ctx.warn(`${service} disabled or inactive — activating…`);
    try {
      ctx.systemd.resetFailed([service]);
      ctx.systemd.activate([service]);
      ctx.ok(`${service} enabled and active`);
      ctx.fix();
    } catch (error) {
      ctx.fail((error as { message: string }).message);
    }
  }
  // A newly generated bearer is read only at process start. Without this restart,
  // doctor would fix the file while leaving the live Eve process unable to accept it.
  if (bearerChanged) {
    ctx.warn("iva.service needs one restart to load the new internal bearer");
    try {
      ctx.systemd.restart(["iva.service"]);
      ctx.ok("iva.service loaded the internal bearer");
      ctx.fix();
    } catch (error) {
      ctx.fail((error as { message: string }).message);
    }
  }
}

async function checkListener(ctx: DoctorContext): Promise<void> {
  // A refreshed unit does not move an already-running old process off 0.0.0.0.
  // Detect the actual socket and restart once so doctor repairs that upgrade state too.
  const port = Number((ctx.readEnv().IVA_PORT || ctx.defaultPort).trim());
  const inspectListener = () => {
    const result = ctx.cap("ss", ["-H", "-ltn", "sport", "=", `:${port}`]);
    return result.code === 0
      ? classifyAgentListeners(result.out, port)
      : "unknown";
  };
  let listener = inspectListener();
  if (listener === "exposed") {
    ctx.warn(
      `iva.service is exposed beyond loopback on port ${port} - restarting securely`,
    );
    try {
      ctx.systemd.restart(["iva.service"]);
      for (let attempt = 0; attempt < 30; attempt++) {
        await ctx.sleep(500);
        listener = inspectListener();
        if (listener === "loopback") break;
      }
      if (listener === "loopback") {
        ctx.ok(`iva.service bound to loopback:${port}`);
        ctx.fix();
      } else {
        ctx.fail(`iva.service still exposed on port ${port}`);
      }
    } catch (error) {
      ctx.fail((error as { message: string }).message);
    }
  } else if (listener === "loopback") {
    ctx.ok(`iva.service bound to loopback:${port}`);
  } else if (listener === "absent") {
    ctx.warn(`no listener found on port ${port}`);
  } else {
    ctx.warn("could not inspect listener addresses (ss unavailable)");
  }
}

/**
 * Фоновые таймеры и (отдельно) oneshot-сервисы ночи. Печать и счёт здесь исторически
 * не совпадают: активный таймер считается молча, а строка-итог не считается вовсе.
 */
function checkTimers(ctx: DoctorContext): void {
  let timerFailed = false;
  for (const timer of ctx.timers) {
    if (ctx.systemd.isEnabled(timer) && ctx.systemd.isActive(timer)) {
      ctx.countOk();
    } else {
      ctx.printWarn(`${timer} disabled or inactive — enabling…`);
      try {
        ctx.systemd.activate([timer]);
        ctx.fix();
      } catch (error) {
        timerFailed = true;
        ctx.fail((error as { message: string }).message);
      }
    }
  }
  if (!timerFailed)
    ctx.printOk(
      `Background timers enabled and active (${ctx.timers.length}: brain + update check)`,
    );
}

// A oneshot service can be inactive and still healthy; its persistent failed state is the
// signal that the last nightly run broke. Query each one only if it is installed here.
// The legacy pre-rename service counts too: a migration that had to keep it (see
// removeLegacyBrainUnits) leaves it carrying the nightly vault care, and a failure there
// costs exactly the same night as a failure of the new one.
function checkNightlyServices(ctx: DoctorContext): void {
  const nightlyServices = [
    ctx.brainService,
    ...LEGACY_BRAIN_UNITS.filter((unit) => unit.endsWith(".service")),
  ].filter((unit) => existsSync(join(ctx.unitDir, unit)));
  for (const service of nightlyServices) {
    const state = ctx.systemd.query("is-failed", service);
    if (state.code === 0 && state.out === "failed") {
      ctx.fail(
        `${service} failed — check: journalctl --user -u ${service} -n 100 --no-pager`,
      );
    } else {
      ctx.ok(`${service} has no failed state`);
    }
  }
}

// daily/weekly/monthly/yearly now run as in-process eve schedules (no systemd unit of
// their own to query for a failed state, unlike doctor above) — data/rollup-status.json
// (scripts/lib/schedule-runner.ts) is the only record of whether they're actually firing.
// Threshold gives each cadence a full extra cycle of slack before doctor complains:
// 26h for the 04:00 daily slot, 8d/32d/370d for weekly/monthly/yearly respectively.
function checkRollupStatus(ctx: DoctorContext): void {
  let rollupStatus: unknown = null;
  try {
    rollupStatus = JSON.parse(
      readFileSync(join(ctx.dataDirectory, "rollup-status.json"), "utf8"),
    );
  } catch {
    // No rollup-status.json yet (fresh install, or nothing has fired yet) — not an error.
  }
  if (!rollupStatus) return;
  const staleAfterHours = {
    daily: 26,
    weekly: 8 * 24,
    monthly: 32 * 24,
    yearly: 370 * 24,
  };
  for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
    // "memory-<period>" — the `name` each agent/schedules/memory-*.ts passes to
    // runScheduledJob, not the bare period (see scripts/lib/schedule-runner.ts).
    const entry = (rollupStatus as RollupStatus)[`memory-${period}`];
    if (!entry) continue; // hasn't fired yet on this install (e.g. yearly, on most installs)
    if (typeof entry.lastSuccessAt === "number") {
      const ageHours = (ctx.now() - entry.lastSuccessAt) / (60 * 60 * 1000);
      const thresholdHours = staleAfterHours[period];
      if (ageHours > thresholdHours) {
        ctx.warn(
          `memory-${period} schedule hasn't succeeded in ${Math.round(ageHours)}h (> ${thresholdHours}h) — check: journalctl --user -u iva.service | grep schedule-runner`,
        );
      } else {
        ctx.ok(
          `memory-${period} schedule last succeeded ${Math.round(ageHours)}h ago`,
        );
      }
    } else {
      ctx.warn(
        `memory-${period} schedule has never succeeded — check: journalctl --user -u iva.service | grep schedule-runner`,
      );
    }
    // A recent success doesn't mean the MOST RECENT attempt was clean — e.g. it
    // succeeded, then a later catch-up retry failed and hasn't run again since.
    // Surface that even when the staleness check above is satisfied.
    // Это взгляд гвардов (data/rollup-status.json), а не история: чем кончился каждый
    // запуск, говорит раздел расписаний выше по таблице фактов (data/jobs.json).
    if (typeof entry.lastExitCode === "number" && entry.lastExitCode !== 0) {
      ctx.warn(
        `memory-${period} schedule's last run exited ${entry.lastExitCode} — check: journalctl --user -u iva.service | grep schedule-runner`,
      );
    }
  }
}

type ReminderStoreModule = {
  reminderFile: typeof import("../../agent/lib/reminder-store.ts").reminderFile;
  parseReminderTable: typeof import("../../agent/lib/reminder-store.ts").parseReminderTable;
};

type ReminderTickModule = {
  readTickPulse: typeof import("../../agent/lib/reminder-tick.ts").readTickPulse;
  REMINDER_TICK_STALE_MS: number;
};

/**
 * Напоминания: пульс минутного диспетчера (mtime data/reminders.tick) и строки,
 * которые сработали за сутки, но не доехали. Модули authored tree грузятся
 * динамически: на урезанной установке их может не быть, и тогда проверка честно
 * пропускается (как очередь моста ниже).
 */
async function checkReminders(ctx: DoctorContext): Promise<void> {
  let store: ReminderStoreModule;
  let tick: ReminderTickModule;
  try {
    [store, tick] = await Promise.all([
      import("../../agent/lib/reminder-store.ts"),
      import("../../agent/lib/reminder-tick.ts"),
    ]);
  } catch {
    // Без authored tree напоминаний на установке нет вовсе.
    return;
  }
  checkReminderPulse(ctx, tick);
  checkReminderFailures(ctx, store);
}

function checkReminderPulse(
  ctx: DoctorContext,
  tick: ReminderTickModule,
): void {
  const pulse = tick.readTickPulse(ctx.dataDirectory);
  if (pulse === null) {
    ctx.warn(
      "reminders: the dispatcher has not ticked yet — stored reminders will not fire (journalctl --user -u iva.service | grep reminders)",
    );
  } else if (ctx.now() - pulse > tick.REMINDER_TICK_STALE_MS) {
    ctx.warn(
      `reminders: the dispatcher has not ticked for ${Math.round((ctx.now() - pulse) / 60_000)}m — stored reminders will not fire`,
    );
  } else {
    ctx.ok("reminders dispatcher ticked recently");
  }
}

function checkReminderFailures(
  ctx: DoctorContext,
  store: ReminderStoreModule,
): void {
  const dayMs = 24 * 60 * 60 * 1000;
  try {
    // Таблицу читаем сами и разбираем экспортированным `parseReminderTable`: стор
    // уносит непарсящийся JSON в карантин (`loadJsonStrict`, json-store.ts:46-58),
    // а доктор — и пакет diagnose, зовущий его, — не переносит данные владельца.
    const file = store.reminderFile();
    const rows = existsSync(file)
      ? store.parseReminderTable(
          file,
          JSON.parse(readFileSync(file, "utf8")),
          ctx.now(),
        )
      : [];
    const failed = rows.filter(
      (row) =>
        row.error !== null &&
        row.firedAt !== null &&
        ctx.now() - row.firedAt <= dayMs,
    );
    for (const row of failed.slice(0, 5)) {
      // Три состояния строки, а не одно: установленный провал, невидимый факт
      // (текст мог уйти, запись не состоялась) и провал позднего шага после
      // отправки. «Не дошло» — только первое; в строке — хеш id и код ошибки.
      const code =
        row.error === null ? "error text omitted" : errorCode(row.error);
      const verdict =
        row.delivered === false
          ? `did not go out: ${code}`
          : row.delivered === null
            ? "the delivery fact was not recorded"
            : `went out, a later step failed: ${code}`;
      // Печать на каждый провал, счёт — один на весь список: сводка считает раздел,
      // а не число строк (как в checkScheduleFacts).
      ctx.printWarn(
        `reminders: #${reminderIdHash(row.id)} fired ${Math.round((ctx.now() - (row.firedAt ?? 0)) / 60_000)}m ago and ${verdict}`,
      );
    }
    if (failed.length > 5)
      ctx.printWarn(
        `reminders: ${failed.length - 5} more failed rows in the last day`,
      );
    if (failed.length > 0) ctx.countWarn();
    else ctx.ok("reminders: nothing failed in the last day");
  } catch (error) {
    // Причина отказа стора несёт JSON строки, то есть текст владельца: в вывод
    // доктора, а он же — раздел пакета diagnose, идёт только класс ошибки.
    ctx.warn(`reminders: table unreadable (${errorName(error)})`);
  }
}

type BridgeState = {
  readonly module: typeof import("../lib/telegram-queue.ts") | null;
  readonly documents: TelegramQueueDocument[];
  readonly unreadable: boolean;
};

type ChatStatusesReport = {
  readonly statuses: ReturnType<typeof listChatStatuses>;
  readonly staleRunMs: number | null;
};

/**
 * Очереди моста. Загрузчик при обычной работе чинит pending/corrupt-файлы, а доктор
 * только наблюдает: подставленные файловые операции подавляют восстановление и запись
 * карантина.
 */
async function loadBridgeState(ctx: DoctorContext): Promise<BridgeState> {
  let module: typeof import("../lib/telegram-queue.ts") | null = null;
  try {
    module = await import("../lib/telegram-queue.ts");
  } catch {
    // Без "#lib"-маппинга (урезанная установка) модуль очередей недоступен —
    // проверка затора моста в этой среде честно пропускается.
  }
  const documents: TelegramQueueDocument[] = [];
  let unreadable = false;
  if (module !== null) {
    const { loadQueueFile, TELEGRAM_QUEUE_ACK_PENDING_SUFFIX } = module;
    const loadBridgeQueue = async (file: string) => {
      const raw = await readFile(file, "utf8");
      if (raw.length === 0) return null;
      return (
        await loadQueueFile(file, {
          strict: true,
          readFileImpl: async (candidate, encoding) => {
            if (candidate.endsWith(TELEGRAM_QUEUE_ACK_PENDING_SUFFIX)) {
              throw Object.assign(new Error("pending recovery is read-only"), {
                code: "ENOENT",
              });
            }
            if (candidate === file) return raw;
            return readFile(candidate, encoding);
          },
          renameImpl: () => Promise.resolve(),
        })
      ).document;
    };
    for (const file of [ctx.telegramInboxFile, ctx.telegramQueueFile]) {
      try {
        const document = await loadBridgeQueue(file);
        if (document) documents.push(document);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT"
        ) {
          continue;
        }
        ctx.warn(
          `bridge backlog: ${file} unreadable — check: journalctl --user -u iva-telegram-poll`,
        );
        unreadable = true;
      }
    }
  }
  return { module, documents, unreadable };
}

async function readChatStatuses(
  ctx: DoctorContext,
): Promise<ChatStatusesReport> {
  try {
    const runStatus = await import("../../agent/lib/run-status.ts");
    return {
      statuses: (ctx.listChatStatuses ?? runStatus.listChatStatuses)(),
      staleRunMs: runStatus.RUN_STALE_MS,
    };
  } catch {
    // Authored tree или run-status каталог недоступны (CLI обязан грузиться
    // и без них) — протухшие чаты в этой среде проверить нечем.
    return { statuses: [], staleRunMs: null };
  }
}

function countStuckChats(
  statuses: ReturnType<typeof listChatStatuses>,
  staleRunMs: number | null,
  checkedAt: number,
): number {
  if (staleRunMs === null) return 0;
  return statuses.filter(
    ({ status }) =>
      status.status === "running" &&
      (typeof status.updatedAt !== "number" ||
        checkedAt - status.updatedAt > staleRunMs),
  ).length;
}

function countQueueItems(
  module: typeof import("../lib/telegram-queue.ts") | null,
  documents: readonly TelegramQueueDocument[],
): { itemCount: number; oldestEnqueuedAt: number | null } {
  let itemCount = 0;
  let oldestEnqueuedAt: number | null = null;
  for (const document of documents) {
    if (module === null) break;
    for (const key of module.queueKeys(document)) {
      for (const item of document.queues[key]) {
        itemCount++;
        if (
          typeof item.enqueuedAt === "number" &&
          Number.isFinite(item.enqueuedAt) &&
          (oldestEnqueuedAt === null || item.enqueuedAt < oldestEnqueuedAt)
        ) {
          oldestEnqueuedAt = item.enqueuedAt;
        }
      }
    }
  }
  return { itemCount, oldestEnqueuedAt };
}

async function checkBridge(ctx: DoctorContext): Promise<void> {
  const { module, documents, unreadable } = await loadBridgeState(ctx);
  const { statuses, staleRunMs } = await readChatStatuses(ctx);
  const checkedAt = ctx.now();
  const stuckChats = countStuckChats(statuses, staleRunMs, checkedAt);
  const { itemCount, oldestEnqueuedAt } = countQueueItems(module, documents);
  const oldestAgeMs =
    itemCount > 0 && oldestEnqueuedAt !== null
      ? checkedAt - oldestEnqueuedAt
      : 0;
  if (stuckChats > 0 || oldestAgeMs > 600_000) {
    const details = [
      ...(stuckChats > 0 ? [`${stuckChats} stuck chat(s)`] : []),
      ...(oldestAgeMs > 600_000
        ? [`oldest item ${Math.round(oldestAgeMs / 60_000)}m old`]
        : []),
    ].join(", ");
    ctx.warn(
      `bridge backlog: ${details} — check: journalctl --user -u iva-telegram-poll; use /stop or iva restart`,
    );
  } else if (!unreadable) {
    ctx.ok("bridge backlog: clear");
  }
}

// 6. Vault + git origin (report only — we don't initiate git operations)
function checkVault(ctx: DoctorContext): string {
  const vaultPath = resolveVaultDir(ctx.root, ctx.env.ASSISTANT_VAULT_DIR);
  if (!existsSync(vaultPath)) {
    ctx.warn(
      `vault not found (${vaultPath}) — created on first memory or: npm run init-vault`,
    );
  } else if (
    ctx.cap("git", ["-C", vaultPath, "remote", "get-url", "origin"]).out
  ) {
    ctx.ok("vault + git origin");
  } else {
    ctx.warn(
      `vault without git origin — memory backup not configured:\n    gh repo create <user>/iva-vault --private --source="${vaultPath}" --remote=origin --push`,
    );
  }
  return vaultPath;
}

/**
 * enforce-report.json is produced by iva-brain.service, so only complain about
 * missing/stale output when that timer is enabled. A fresh report is still useful either way.
 */
function checkMaintenance(ctx: DoctorContext, vaultPath: string): void {
  const maintenanceTimerEnabled = ctx.systemd.isEnabled(ctx.brainTimer);
  const maintenanceReport = readMemoryMaintenanceReport(
    join(vaultPath, ".graph/enforce-report.json"),
  );
  if (maintenanceReport.status === "fresh") {
    if (maintenanceReport.problems.length) {
      ctx.warn(
        `ночной maintenance сообщает о проблемах: ${maintenanceReport.problems
          .map(({ key, count }) => `${key}=${count}`)
          .join(", ")}`,
      );
    } else {
      ctx.ok("Ночной maintenance-отчёт свежий, проблем нет");
    }
  } else if (maintenanceTimerEnabled) {
    if (maintenanceReport.status === "invalid")
      ctx.warn("ночной maintenance оставил нечитаемый отчёт");
    else ctx.warn("ночной maintenance давно не отчитывался");
  }
}

type PluginCore = NonNullable<Awaited<ReturnType<typeof tryLoadPluginCore>>>;

type PluginsState = Awaited<
  ReturnType<PluginCore["store"]["readPluginsStateSafe"]>
>["state"];

/**
 * Есть ли код плагина в версии, которая работает. `null` — версий тут нет вовсе
 * (development checkout): сборка плагинов там не при чём, и говорить не о чем.
 */
function codeBuiltIntoVersion(
  ctx: DoctorContext,
  name: string,
): boolean | null {
  const install = ctx.install;
  if (!install || install.kind !== "version") return null;
  const store = createVersionStore(install.home);
  const active = store.currentName();
  if (!active) return null;
  const dir = join(store.layout.versions, active);
  return (
    existsSync(join(dir, pluginMount(name))) &&
    existsSync(join(dir, pluginDirectory(name)))
  );
}

/**
 * Отвечает ли MCP proxy на `/health`. Юнит может быть active и при мёртвом
 * сервере за ним — прокси уходит вслед за ребёнком, но между падением и рестартом
 * есть окно, и «active» о нём не знает. Bearer здесь не нужен: `/health` отвечает
 * без него именно для этой проверки.
 */
async function proxyHealthy(port: number): Promise<boolean> {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!answer.ok) return false;
    const body: unknown = await answer.json();
    return (
      typeof body === "object" && body !== null && "ok" in body && !!body.ok
    );
  } catch {
    return false;
  }
}

/**
 * Plugins (ADR-0009) идут последними и в обоих выходах доктора: манифесты,
 * plugins.json, сборка кода в работающей версии и юниты — MCP proxy с его
 * `/health` и сервисы плагина.
 */
async function checkPlugins(ctx: DoctorContext): Promise<void> {
  // Плагины читает authored tree, а доктор обязан работать и на установке, где
  // его нет (ADR-0003) — отсюда загрузка по требованию и честная строка вместо
  // падения, когда загружать нечего.
  const core = await tryLoadPluginCore();
  if (!core) {
    ctx.warn(
      "plugins not checked: the agent tree is missing — run: iva update",
    );
    return;
  }
  const { pluginsDir, readPluginsStateSafe } = core.store;
  const directory = pluginsDir(ctx.dataDirectory);
  const { state, damaged } = await readPluginsStateSafe(ctx.dataDirectory);
  if (damaged) {
    ctx.fail(`plugins.json is unusable: ${damaged.message}`);
    return;
  }
  const leftovers = new Set(leftoverPluginDirs(directory));
  const folders = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !leftovers.has(entry.name),
        )
        .map((entry) => entry.name)
    : [];
  // Юниты плагинов, которые сейчас на диске: их читаем до раннего выхода, иначе
  // юнит, оставшийся от снятого плагина, на пустой установке никто бы не назвал.
  const onDisk = ctx.hasSystemd() ? installedPluginUnits(ctx.unitDir) : [];
  // Плагинов нет вообще — доктору сказать нечего, и молчание здесь честнее
  // строки «0 плагинов» в отчёте установки, которая их никогда не видела.
  if (
    state.plugins.length === 0 &&
    folders.length === 0 &&
    leftovers.size === 0 &&
    onDisk.length === 0
  )
    return;
  const expected = await checkPluginEntries(ctx, core, state);
  await checkPluginUnits(ctx, expected, onDisk);
  reportPluginFolders(ctx, state, folders, leftovers);
}

/**
 * Строка на каждый плагин: манифест, конфиг владельца, сборка кода в работающей версии.
 * Заодно собирает юниты, которые ДОЛЖНЫ быть: пересечение выданных портов с тем, что
 * плагин объявляет СЕЙЧАС. Порт из `plugins.json` не отбирается никогда (он в юните и в
 * connection-файле), поэтому список только по нему обещал бы юнит серверу, которого в
 * `mcp.json` больше нет, — и `sync` не смог бы этого починить.
 */
async function checkPluginEntries(
  ctx: DoctorContext,
  core: PluginCore,
  state: PluginsState,
): Promise<Map<string, { plugin: string; port?: number }>> {
  const expected = new Map<string, { plugin: string; port?: number }>();
  for (const entry of state.plugins)
    await checkPluginEntry(ctx, core, entry, expected);
  return expected;
}

async function checkPluginEntry(
  ctx: DoctorContext,
  core: PluginCore,
  entry: PluginsState["plugins"][number],
  expected: Map<string, { plugin: string; port?: number }>,
): Promise<void> {
  const { readPlugin } = core.reader;
  const { readPluginConfigState } = core.config;
  const { pluginConfigFile, pluginRoot } = core.store;
  const root = pluginRoot(ctx.dataDirectory, entry.name);
  if (!existsSync(root)) {
    ctx.fail(
      `plugin ${entry.name} is missing from data/custom/plugins/ — run: iva plugin sync`,
    );
    return;
  }
  const report = await readPlugin(root);
  if (!report.manifest) {
    ctx.fail(
      `plugin ${entry.name} is unreadable: ${pluginReadProblem(report)}`,
    );
    return;
  }
  for (const line of report.diagnostics) {
    ctx.warn(`plugin ${entry.name}: ${line}`);
  }
  // Конфиг владельца рантайм читает молча и на ошибке берёт пустой: настройка
  // исчезает, и назвать файл больше некому.
  const config = readPluginConfigState(entry.name, ctx.dataDirectory);
  if (config.state === "damaged") {
    ctx.fail(
      `plugin ${entry.name}: ${basename(pluginConfigFile(ctx.dataDirectory, entry.name))} is unusable: ${config.reason}`,
    );
  }
  const parts = [`${report.skills.length} skills`];
  if (report.code) parts.push("code");
  const servers = Object.keys(report.mcp).length;
  if (servers) parts.push(`${servers} mcp`);
  ctx.ok(
    `plugin ${entry.name}${entry.enabled ? "" : " (disabled)"}: ${parts.join(", ")}`,
  );
  if (entry.enabled && entry.trusted)
    expectPluginUnits(report, entry, expected);
  // Код плагина живёт в версии, а не в папке (ADR-0009): запись «включён» без
  // сборки в работающей версии значит, что тулов плагина у агента нет.
  if (report.code && entry.enabled) {
    const built = codeBuiltIntoVersion(ctx, entry.name);
    if (built === false) {
      ctx.warn(
        `plugin ${entry.name}: built into current version: no — run: iva update`,
      );
    } else if (built === true) {
      ctx.ok(`plugin ${entry.name}: built into current version: yes`);
    }
  }
}

/**
 * Юниты, которых требует включённый и доверенный плагин: стандартный ввод объявленных MCP
 * и сервисы, которые плагин ещё несёт в манифесте.
 */
function expectPluginUnits(
  report: Awaited<ReturnType<PluginCore["reader"]["readPlugin"]>>,
  entry: PluginsState["plugins"][number],
  expected: Map<string, { plugin: string; port?: number }>,
): void {
  for (const [server, ports] of Object.entries(entry.mcp ?? {})) {
    if (report.mcp[server]?.type !== "stdio") continue;
    expected.set(mcpUnitName(entry.name, server), {
      plugin: entry.name,
      port: ports.port,
    });
  }
  for (const service of Object.keys(entry.services ?? {})) {
    if (!report.services[service]) continue;
    expected.set(serviceUnitName(entry.name, service), {
      plugin: entry.name,
    });
  }
}

/** Юниты плагинов: те, что должны быть, и те, что лежат лишними. */
async function checkPluginUnits(
  ctx: DoctorContext,
  expected: Map<string, { plugin: string; port?: number }>,
  onDisk: readonly string[],
): Promise<void> {
  if (ctx.hasSystemd()) {
    for (const [unit, about] of [...expected].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (!existsSync(join(ctx.unitDir, unit))) {
        ctx.warn(
          `plugin ${about.plugin}: ${unit} is missing — run: iva plugin sync`,
        );
        continue;
      }
      if (!ctx.systemd.isActive(unit)) {
        ctx.fail(
          `plugin ${about.plugin}: ${unit} is not running — check: journalctl --user -u ${unit} -n 100 --no-pager`,
        );
        continue;
      }
      // Живой прокси обязан ещё и отвечать: юнит active говорит только о процессе.
      if (about.port !== undefined) {
        if (await proxyHealthy(about.port)) {
          ctx.ok(
            `plugin ${about.plugin}: ${unit} answers on 127.0.0.1:${about.port}`,
          );
        } else {
          ctx.warn(
            `plugin ${about.plugin}: ${unit} runs but does not answer on 127.0.0.1:${about.port} — check: journalctl --user -u ${unit} -n 100 --no-pager`,
          );
        }
        continue;
      }
      ctx.ok(`plugin ${about.plugin}: ${unit} running`);
    }
    for (const unit of onDisk) {
      if (expected.has(unit)) continue;
      ctx.warn(
        `${unit} belongs to no enabled and trusted plugin — run: iva plugin sync`,
      );
    }
  } else if (expected.size > 0) {
    ctx.warn(
      `${expected.size} plugin unit(s) are not checked: systemd is not available here`,
    );
  }
}

function reportPluginFolders(
  ctx: DoctorContext,
  state: PluginsState,
  folders: readonly string[],
  leftovers: ReadonlySet<string>,
): void {
  for (const name of folders) {
    if (state.plugins.some((entry) => entry.name === name)) continue;
    ctx.warn(
      `plugin folder ${name} is not in plugins.json — run: iva plugin sync`,
    );
  }
  for (const name of leftovers) {
    ctx.warn(
      `plugin folder ${name} is a leftover of an interrupted install — run: iva plugin sync`,
    );
  }
}

// Правила владельца: markdown-файлы слота читает с диска
// agent/instructions/30-owner-rules.ts, поэтому доктору нужен только счёт. Файл-замена
// инструкции заморожен на дне правки и прячет всё, что приехало релизом, — его доктор
// называет отдельно, а не молчит (как у плагинов, когда тех нет).
async function checkOwnerRules(ctx: DoctorContext): Promise<void> {
  const custom = join(ctx.dataDirectory, "custom", "agent");
  if (existsSync(join(custom, "instructions.md"))) {
    ctx.warn(
      "replacement persona data/custom/agent/instructions.md is deprecated and hides every rule shipped since it was written - move your rules to data/custom/agent/instructions/rules.md (docs/extending.md) and remove the file",
    );
  }
  let rules: typeof import("../../agent/lib/owner-rules.ts");
  try {
    rules = await import("../../agent/lib/owner-rules.ts");
  } catch {
    // Авторское дерево недоступно (урезанная установка) — считать правила нечем.
    ctx.warn(
      "owner rules not checked: the agent tree is missing — run: iva update",
    );
    return;
  }
  const { files, chars } = rules.readOwnerRules(join(custom, "instructions"));
  if (files.length === 0) return;
  if (chars > rules.OWNER_RULES_CAP) {
    ctx.warn(
      `owner rules: ${chars} chars over the ${rules.OWNER_RULES_CAP} cap - shorten or move the long part into a skill`,
    );
    return;
  }
  ctx.ok(
    `owner rules: ${files.length} file${files.length === 1 ? "" : "s"}, ${chars} chars`,
  );
}

/** Последний шаг обоих выходов доктора: плагины, правила владельца, сводка и код возврата. */
async function finishDoctor(ctx: DoctorContext): Promise<void> {
  await checkPlugins(ctx);
  await checkOwnerRules(ctx);
  ctx.log();
  const counts = ctx.report();
  ctx.log(
    `${ctx.colors.b}Summary:${ctx.colors.x} ${ctx.colors.g}${counts.ok} ok${ctx.colors.x} · ${ctx.colors.y}${counts.warn} warn${ctx.colors.x} · ${ctx.colors.c}${counts.fix} fixed${ctx.colors.x} · ${ctx.colors.r}${counts.bad} fail${ctx.colors.x}`,
  );
  ctx.exit(counts.bad > 0 ? 1 : 0);
}
