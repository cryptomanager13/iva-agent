// Brain: deterministic nightly vault care (no LLM) + git commit&push.
// Runs nightly via systemd timer (deploy/iva-brain.{service,timer}).
//
//   node --env-file-if-exists=.env scripts/memory/brain.ts
//
// Файл читается, только если он есть: юнит несёт EnvironmentFile, а сам brain чинит
// установку и в том состоянии, где .env потерян.
// Runs the autograph scripts (graph.health / engine.decay / moc.generate /
// dedup / link_cleanup) on the vault via `uv run`, then commits and pushes the vault repo.
// Guards: no git-remote/credentials → alert admin on Telegram (gh auth login + git remote),
// push is skipped. Health score drop → alert on Telegram. Plain Node orchestration.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVaultSweep } from "../lib/vault-pair.ts";
import {
  classifyGitPushError,
  ensureVaultGitignore,
  formatMegabytes,
  recordSkippedOversize,
  scanOversizeWorkingTreeFiles,
} from "../lib/memory-maintenance.ts";
import {
  alertOnce,
  alertResolved,
  noticeTranslator,
} from "../lib/notice-policy.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { redactNotice } from "../lib/notice.ts";
import { resolveDataDir } from "../lib/data-dir.ts";
import { resolveTimeZone } from "../lib/timezone.ts";
import { vaultDirOrExit } from "../lib/vault-boundary.ts";

let vaultCache: string | null = null;
// Лениво: неверная настройка вольта всплывает на первом использовании, где её ловит
// граница процесса — одна строка причины и код 1, а не стек на импорте модуля.
const VAULT = (): string => (vaultCache ??= vaultDirOrExit());
const DATA_DIR = resolveDataDir(process.cwd());
// The autograph code lives in THIS repo, not in the vault: the vault is user data only.
// Absolute paths, because every script is spawned with cwd = vault (they take "." as the vault).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = resolve(ROOT, "scripts/autograph");
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = notificationChat(); // admin chat
const TZ = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface HealthHistoryEntry {
  date: string;
  health_score: number;
}

interface SupersedeSkip {
  path: string;
  reason: "invalid_utf8" | "malformed_frontmatter" | "read_error";
}

/** Причины, которые эмитит scripts/autograph/supersede.py (CardSkip.reason). */
const SUPERSEDE_REASONS = new Set([
  "invalid_utf8",
  "malformed_frontmatter",
  "read_error",
]);

/**
 * Чем запись отчёта supersede не похожа на запись отчёта supersede, или null.
 *
 * Наружу отдаётся только имя поля и, если причина похожа на причину, она сама:
 * значение `path` - путь карточки владельца, в журнал он не идёт.
 */
function supersedeSkipProblem(item: unknown): string | null {
  if (!isRecord(item)) return "is not an object";
  if (typeof item.path !== "string") return 'has no "path" string';
  if (typeof item.reason !== "string") return 'has no "reason" string';
  if (!SUPERSEDE_REASONS.has(item.reason))
    return /^[a-z0-9_]{1,40}$/.test(item.reason)
      ? `has an unknown "reason" ${item.reason}`
      : 'has an unknown "reason"';
  return null;
}

function isSupersedeSkip(item: unknown): item is SupersedeSkip {
  return supersedeSkipProblem(item) === null;
}

type HealthHistoryState =
  | { state: "missing" }
  | { state: "valid"; entries: HealthHistoryEntry[] }
  | { state: "corrupt" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHealthHistoryEntry(value: unknown): value is HealthHistoryEntry {
  if (!isRecord(value)) return false;
  if (typeof value.date !== "string" || !validIsoDate(value.date)) return false;
  return (
    typeof value.health_score === "number" &&
    Number.isFinite(value.health_score)
  );
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

if (!existsSync(VAULT())) {
  console.error(`brain: vault not found: ${VAULT()}`);
  process.exit(1);
}

function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Run a command in the vault directory. Does not throw — returns status/output.
// Null status (signal kill, spawn error) is a failure, never a success: an uv
// killed mid-step otherwise counted as a passed step.
function run(cmd: string, args: string[], cwd = VAULT()) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (out) console.log(`$ ${cmd} ${args.join(" ")}\n${out}`);
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

// Every alert here is built from runtime data: the stderr of a git push (which is
// where a remote URL carrying a token shows up), card paths, error text. The Gate
// stands on the send itself (the rule: agent/lib/outbox.ts). Returns whether the
// message really reached Telegram — an alert that never left must not silence the next one.
async function telegram(message: string): Promise<boolean> {
  const text = await redactNotice(message);
  if (!BOT || !CHAT) {
    console.error(
      "brain: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — alert not sent:",
      text,
    );
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text }),
  });
  if (!res.ok) {
    console.error(
      "brain: Telegram sendMessage failed:",
      res.status,
      await res.text(),
    );
    return false;
  }
  return true;
}

// An Alert cannot be switched off (ADR-0007), so it earns the interruption twice over: it
// says what broke, what it costs and what to do, and it repeats at most once a week for the
// same problem. `essence` is the substance of the problem — a different substance is a
// different problem and speaks at once.
async function alert(
  key: string,
  essence: string,
  message: string,
): Promise<void> {
  const outcome = await alertOnce(DATA_DIR, key, essence, () =>
    telegram(message),
  );
  if (outcome === "throttled")
    console.log(
      `brain: ${key} is unchanged since the last alert — not repeated`,
    );
}

// The problem is gone: forget it, so tomorrow's relapse speaks at once instead of waiting
// out the week.
const cleared = (key: string): void => alertResolved(DATA_DIR, key);

// Health score is read from the history that graph.py health appends after each run.
function readHealthHistory(): HealthHistoryState {
  const p = resolve(VAULT(), ".graph/health-history.json");
  let raw: Buffer;
  try {
    raw = readFileSync(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "missing" };
    return { state: "corrupt" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || !data.every(isHealthHistoryEntry))
      return { state: "corrupt" };
    return { state: "valid", entries: data };
  } catch {
    return { state: "corrupt" };
  }
}

interface CardTools {
  readonly coreCap: number;
  readonly clampCore: (text: string) => string;
  readonly scanUnclosedFenceCards: (vaultPath: string) => string[];
  readonly writeFileAtomicSync: (path: string, data: string) => void;
}

// The CORE cap and the fence rules describe the card format, so they live in the authored
// tree — which eve rebuilds at service start and which `iva update --force` rebuilds when it is
// missing or half-written (ADR-0003). This unit's load-bearing job is §3, the vault backup,
// and that needs no tree at all: the tree is therefore reached through a dynamic import here,
// so its absence costs §1b and §1c and is reported, instead of killing the nightly backup at
// module resolution.
async function loadCardTools(): Promise<CardTools | null> {
  try {
    const [coreCap, coreClamp, fences, fsAtomic] = await Promise.all([
      import("#lib/core-cap.ts"),
      import("#lib/core-clamp.ts"),
      import("./card-fences.ts"),
      import("#lib/fs-atomic.ts"),
    ]);
    return {
      coreCap: coreCap.CORE_CAP,
      clampCore: coreClamp.clampCore,
      scanUnclosedFenceCards: fences.scanUnclosedFenceCards,
      writeFileAtomicSync: fsAtomic.writeFileAtomicSync,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`brain: agent/ is not loadable: ${detail}`);
    return null;
  }
}

const today = localDate();
// Language of every line below. Resolved once per run: the nightly pass is minutes long,
// and a translator is a function, so no translated string is frozen in a module constant.
const T = await noticeTranslator();
console.log(`=== brain for ${today} (vault: ${VAULT()}) ===`);

// ── 0. Schema location: vault root, with a one-time migration off the legacy path ──
// Up to 0.3.2 the per-vault schema sat in vault/.claude/skills/autograph/schema.json (a
// leftover of the Claude-skill layout). It is user config, so it now lives at the vault
// root; the legacy copy is left in place (never delete user data), just no longer read.
const VAULT_SCHEMA = resolve(VAULT(), "schema.json");
const LEGACY_SCHEMA = resolve(VAULT(), ".claude/skills/autograph/schema.json");
if (!existsSync(VAULT_SCHEMA) && existsSync(LEGACY_SCHEMA)) {
  copyFileSync(LEGACY_SCHEMA, VAULT_SCHEMA);
  console.log(`brain: schema migrated to the vault root: ${VAULT_SCHEMA}`);
}
// Fall back to the shipped example so a vault that never had a schema still gets enforced.
const SCHEMA = existsSync(VAULT_SCHEMA)
  ? VAULT_SCHEMA
  : existsSync(LEGACY_SCHEMA)
    ? LEGACY_SCHEMA
    : resolve(SCRIPTS, "schema.example.json");

// ── 1. Mechanical maintenance (autograph, no LLM) ──
// Do NOT ignore failures: otherwise brain would commit/push and exit 0 even though health/
// decay/moc did not run (no uv/Python, vault not initialized, etc.).
const failures: string[] = [];
const CORRUPT_HISTORY_ERROR =
  "Error: health history is corrupt; left unchanged";
let corruptHistoryGraphFailure = false;
function maint(label: string, args: string[]) {
  const r = run("uv", ["run", ...args]);
  if (r.status !== 0) {
    failures.push(label);
    if (label === "graph.health" && r.stderr.trim() === CORRUPT_HISTORY_ERROR)
      corruptHistoryGraphFailure = true;
  }
  return r;
}
// cleanup — streaming repair of bug-bloated cards. MUST run before everything else:
// enforce/graph read files whole and get OOM-killed on gigabyte cards; cleanup streams
// with bounded memory and shrinks them back to sane sizes first.
maint("cleanup", [`${SCRIPTS}/cleanup.py`, ".", "--apply"]);
// enforce — strict-typing backstop: coerce type aliases, fix invalid status, backfill
// system fields. Runs FIRST (before graph) so the graph is built on canonical frontmatter.
// This is the deterministic guarantee that cards written outside write_card stay in-schema.
maint("enforce", [`${SCRIPTS}/enforce.py`, ".", SCHEMA, "--apply"]);
// graph.fix rewrites Cards whose wikilinks resolve to exactly one target (path, stem or H1
// title); ambiguous ones are left as they are. Runs before graph.health so the score is
// measured after the repair.
maint("graph.fix", [
  `${SCRIPTS}/graph.py`,
  "fix",
  ".",
  SCHEMA,
  "--apply",
  "--as-of",
  today,
]);
// graph.health rebuilds the graph and writes health-history.json (for drop detection).
maint("graph.health", [
  `${SCRIPTS}/graph.py`,
  "health",
  ".",
  SCHEMA,
  "--as-of",
  today,
]);
// engine.decay updates card relevance/tiers.
maint("engine.decay", [`${SCRIPTS}/engine.py`, "decay", "."]);
// moc.generate rebuilds the MOC indexes.
maint("moc.generate", [`${SCRIPTS}/moc.py`, "generate", "."]);
// supersede — deterministic contradiction scan (dry-run): reports same-entity cards with
// conflicting fields to .graph/supersede-candidates.json; the nightly LLM rollup resolves them.
const supersedeSkippedPaths = new Set<string>();
const supersedeRepairCommand =
  `cd ${shellQuote(ROOT)} && ` +
  `uv run scripts/autograph/supersede.py ${shellQuote(VAULT())}`;
const supersedeReportPath = shellQuote(
  resolve(VAULT(), ".graph/supersede-report.json"),
);
const supersede = maint("supersede", [`${SCRIPTS}/supersede.py`, "."]);
if (supersede.status === 0) {
  // Отчёт мог не записаться (обрыв посреди записи, стёртый .graph, чужой формат)
  // при успешном коде шага: это провал шага с понятной причиной, а не падение
  // ночи — дальше идёт общий путь провала (алерт maintenance со списком шагов).
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(resolve(VAULT(), ".graph/supersede-report.json"), "utf8"),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`brain: supersede report unreadable: ${detail}`);
    failures.push("supersede");
  }
  if (parsed !== undefined) {
    if (!isRecord(parsed) || !Array.isArray(parsed.skipped)) {
      console.error("brain: supersede report is not a supersede report");
      failures.push("supersede");
    } else {
      // Запись, не подходящую под известную форму, НЕЛЬЗЯ отфильтровать в ноль: ноль
      // означал бы «пропущенных карточек нет», шаг зелёный и алерт погашен, тогда как
      // на деле отчёт написан не тем, кого мы читаем. Провал шага - как и у отчёта,
      // который вовсе не отчёт. В журнал идут только номер записи и имя поля или
      // причина: путь карточки - данные владельца, им в журнале не место.
      const wrong = parsed.skipped
        .map((item, index) => ({ index, problem: supersedeSkipProblem(item) }))
        .filter((entry) => entry.problem !== null);
      const skipped = parsed.skipped.filter(isSupersedeSkip);
      for (const entry of wrong)
        console.error(
          `brain: supersede report entry ${entry.index} ${entry.problem}`,
        );
      // Пока в отчёте есть чужая запись, про пропущенные карточки не утверждается
      // ничего: ни алерта (счёт был бы неполон), ни его гашения (гашение сказало бы
      // «всё чисто»), ни гашения карточек в алерте про незакрытый фенс: список путей
      // заведомо неполон. Шаг провален, владелец увидит его в общем алерте ночи.
      if (wrong.length) {
        failures.push("supersede");
      } else if (skipped.length) {
        for (const item of skipped) supersedeSkippedPaths.add(item.path);
        const count = skipped.length;
        const essence = createHash("sha256")
          .update(JSON.stringify(skipped))
          .digest("hex");
        await alert(
          "supersede-unreadable",
          essence,
          T(
            `Supersede skipped unreadable Cards. Conflicts in ${count} ${count === 1 ? "Card" : "Cards"} will not reach Rollup. ` +
              `Run this command:\n${supersedeRepairCommand}\n` +
              `Then open this report:\n${supersedeReportPath}\n` +
              "Repair the listed Cards.",
            `Supersede пропустил нечитаемые карточки. Противоречия в ${count} ${count === 1 ? "карточке" : "карточках"} не попадут в Rollup. ` +
              `Выполни команду:\n${supersedeRepairCommand}\n` +
              `Потом открой отчёт:\n${supersedeReportPath}\n` +
              "Почини перечисленные карточки.",
          ),
        );
      } else {
        cleared("supersede-unreadable");
      }
    }
  }
}
// dedup and link_cleanup — dry-run only (autograph policy: never apply automatically).
maint("dedup", [`${SCRIPTS}/dedup.py`, ".", "--dry-run"]);
maint("link_cleanup", [`${SCRIPTS}/link_cleanup.py`, "."]);

// Плагин: пересобрать сайдкар эмбеддингов для hybrid-поиска (только если включён). Запускаем
// из корня проекта (cwd), а не из VAULT() — скрипт лежит в scripts/, ключ читается из .env.
if (process.env.MEMORY_SEARCH_MODE === "hybrid") {
  // Use process.execPath, not bare "node": the systemd unit's PATH does not include the
  // nvm node dir, so spawning "node" by name fails with ENOENT and falsely reports a failure.
  const r = run(
    process.execPath,
    ["--env-file-if-exists=.env", "scripts/memory/embed-index.ts"],
    process.cwd(),
  );
  if (r.status !== 0) failures.push("embed-index");
}

const history = readHealthHistory();
const maintenanceFailures =
  corruptHistoryGraphFailure && history.state === "corrupt"
    ? failures.filter((label) => label !== "graph.health")
    : failures;
if (maintenanceFailures.length) {
  const steps = maintenanceFailures.join(", ");
  await alert(
    "maintenance",
    steps,
    T(
      `Nightly memory care failed at: ${steps}. Cards stay off-schema and the topic index goes stale. ` +
        "On the server run: uv --version. It says nothing: install uv with " +
        "curl -LsSf https://astral.sh/uv/install.sh | sh",
      `Ночной уход за памятью не прошёл на шагах: ${steps}. Карточки остаются вне схемы, индекс тем устаревает. ` +
        "Выполни на сервере: uv --version. Пусто — поставь uv: " +
        "curl -LsSf https://astral.sh/uv/install.sh | sh",
    ),
  );
} else {
  cleared("maintenance");
}

// ── 1a. The card format §1b and §1c work from ──
const cards = await loadCardTools();
if (!cards) {
  failures.push("authored tree");
  await alert(
    "authored-tree",
    "unloadable",
    T(
      "Iva's own files could not be loaded. The CORE.md size check and the broken-card scan were skipped. " +
        "The memory backup still ran. To rebuild Iva's files, on the server run: iva update --force",
      "Файлы самой Ивы не читаются. Проверка размера CORE.md и поиск битых карточек пропущены. " +
        "Бэкап памяти всё равно прошёл. Пересобрать файлы Ивы: выполни на сервере iva update --force",
    ),
  );
} else {
  cleared("authored-tree");
}

// ── 1b. CORE guard: CORE must stay small (always-on floor stays flat) ──
// This runs before git add/commit below, so a repaired CORE is included in the nightly backup.
const corePath = resolve(VAULT(), "CORE.md");
// Забываем проблему только там, где её реально проверили: без authored tree размер CORE
// измерить нечем, и «почищено» было бы выдумкой. Запись при этом ничего не блокирует — как
// только дерево вернётся, ближайшая ночь либо снова скажет, либо очистит.
let coreChecked = false;
let coreClamped = false;
if (cards && existsSync(corePath)) {
  const { coreCap, clampCore, writeFileAtomicSync } = cards;
  coreChecked = true;
  const oldCore = readFileSync(corePath, "utf8");
  if (oldCore.length > coreCap) {
    const newCore = clampCore(oldCore);
    writeFileAtomicSync(corePath, newCore);
    console.warn(
      `brain: CORE.md clamped ${oldCore.length} → ${newCore.length} chars (cap ${coreCap})`,
    );
    const stillOver = newCore.length > coreCap;
    coreClamped = true;
    await alert(
      "core-cap",
      stillOver ? "protected-overflow" : "clamped",
      T(
        `CORE.md grew past its ${coreCap}-character cap. I trimmed it from ${oldCore.length} to ` +
          `${newCore.length} characters. Pointers stayed in place. Open CORE.md and check that ` +
          "nothing important is gone." +
          (stillOver
            ? " Protected headings and unknown sections are still over the cap."
            : ""),
        `CORE.md вырос за лимит в ${coreCap} знаков. Я ужала его с ${oldCore.length} до ` +
          `${newCore.length} знаков. Указатели на месте. Открой CORE.md и проверь, что ` +
          "важное не пропало." +
          (stillOver
            ? " Защищённые заголовки и неизвестные секции всё ещё за лимитом."
            : ""),
      ),
    );
  }
}
if (coreChecked && !coreClamped) cleared("core-cap");

// ── 1c. Cards with an unclosed code fence (report only, never repaired) ──
// Such a card reads as one long code block: its ## History and ## Log are no longer
// sections, so write_card refuses UPDATE and SUPERSEDE on it rather than write the fact
// into code. Where the author meant to close the fence is unknowable, so brain only names
// the files - guessing would rewrite the user's text.
const unclosed = cards
  ? cards
      .scanUnclosedFenceCards(VAULT())
      .filter((path) => !supersedeSkippedPaths.has(path))
  : [];
if (unclosed.length) {
  const shown = unclosed.slice(0, 10);
  const rest = unclosed.length - shown.length;
  const list = shown.map((path) => `- ${path}`).join("\n");
  const message = T(
    `Cards with an unclosed \`\`\` fence: ${unclosed.length}. Iva cannot update or replace ` +
      "facts in them, so new facts on these subjects are lost. Close the fence by hand:\n" +
      list +
      (rest ? `\n… and ${rest} more` : ""),
    `Карточек с незакрытым \`\`\`: ${unclosed.length}. Ива не может обновлять и заменять в них ` +
      "факты, поэтому новые факты по этим темам теряются. Закрой фенс вручную:\n" +
      list +
      (rest ? `\n… и ещё ${rest}` : ""),
  );
  console.warn(`brain: ${message}`);
  await alert("unclosed-fence", unclosed.join(","), message);
} else if (cards) {
  // Скан прошёл и ничего не нашёл. Без дерева (cards === null) он не выполнялся вовсе —
  // забывать непроверенное нельзя.
  cleared("unclosed-fence");
}

// ── 2. Detect health score drop ──
if (history.state === "corrupt") {
  await alert(
    "health-history-corrupt",
    "corrupt",
    T(
      "Vault health history is corrupt. Graph cannot append a health result, so the health " +
        "trend is unavailable. The file was left unchanged. Move .graph/health-history.json " +
        "aside, then run npm run doctor from Iva.",
      "health-history.json повреждён. Graph не может дописать результат, поэтому история " +
        "здоровья недоступна. Файл оставлен без изменений. Перемести .graph/health-history.json " +
        "в сторону, затем запусти npm run doctor из каталога Ивы.",
    ),
  );
} else {
  cleared("health-history-corrupt");
}
// То же правило, что у CORE и фенсов: забываем только то, что реально проверили. Меньше двух
// точек — сравнивать нечего, проверки не было, и отметка дросселя просто доживает свою неделю.
let healthDropped = false;
if (history.state === "valid" && history.entries.length >= 2) {
  const cur = history.entries[history.entries.length - 1]?.health_score;
  const prev = history.entries[history.entries.length - 2]?.health_score;
  if (typeof cur === "number" && typeof prev === "number" && cur < prev) {
    healthDropped = true;
    await alert(
      "health-drop",
      "dropping",
      T(
        `Vault health dropped: ${prev} → ${cur} of 100. Links are breaking, so memory search ` +
          "finds less. Open vault/.graph/report.md and see what fell.",
        `Здоровье vault упало: ${prev} → ${cur} из 100. Связи рвутся, поиск по памяти находит ` +
          "меньше. Открой vault/.graph/report.md и посмотри, что просело.",
      ),
    );
  }
  if (!healthDropped) cleared("health-drop");
}

// ── 3. Git commit & push ──
// Check the complete working-tree snapshot before staging anything. If even one file is
// unsafe, skip the whole commit: a partial commit would make the nightly backup look complete
// while silently omitting vault data.
let oversized: Array<{ path: string; size: number }>;
try {
  oversized = scanOversizeWorkingTreeFiles({
    vaultPath: VAULT(),
    runGit: (args: string[]) => run("git", args),
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const message = T(
    `The file-size check before the backup failed (${detail}). The memory backup is on hold, ` +
      "so today's memory is not saved off the server yet. On the server run df -h for free space. " +
      `Then run: cd ${VAULT()} && git status`,
    `Проверка размеров файлов перед бэкапом не прошла (${detail}). Бэкап памяти отложен, ` +
      "сегодняшняя память ещё не сохранена вне сервера. Выполни на сервере df -h — сколько места. " +
      `Потом выполни: cd ${VAULT()} && git status`,
  );
  console.warn(`brain: ${message}`);
  await alert("backup-scan", "unreadable", message);
  process.exit(1);
}
cleared("backup-scan");

if (oversized.length) {
  recordSkippedOversize(
    resolve(VAULT(), ".graph/enforce-report.json"),
    oversized.length,
  );
  const lines = oversized.map(({ path, size }) =>
    T(
      `File ${path} (${formatMegabytes(size)}) is over the GitHub limit.`,
      `Файл ${path} (${formatMegabytes(size)}) больше лимита GitHub.`,
    ),
  );
  for (const line of lines) console.warn(`brain: ${line}`);
  await alert(
    "backup-oversize",
    oversized.map(({ path }) => path).join(","),
    T(
      `${lines.join("\n")}\nThe memory backup is on hold until these files shrink. New memory ` +
        "stays on the server only. Shrink them now: /menu → 🛠 Maintenance → 🧹 Vault cleanup.",
      `${lines.join("\n")}\nБэкап памяти отложен, пока эти файлы не уменьшатся. Новая память ` +
        "остаётся только на сервере. Ужми их сейчас: /menu → 🛠 Обслуживание → 🧹 Чистка vault.",
    ),
  );
  process.exit(1);
}
cleared("backup-oversize");

// Auto-provision a private backup remote via the already-authorized gh CLI instead of
// nagging nightly: only alert when gh itself can't help (not installed / not logged in).
function ensureRemote(): string {
  const existing = run("git", ["remote", "get-url", "origin"]);
  if (existing.status === 0 && existing.stdout.trim())
    return existing.stdout.trim();

  if (run("gh", ["auth", "status"]).status !== 0) return ""; // gh missing or not authed
  run("gh", ["auth", "setup-git"]); // make https push use gh credentials

  // Create the private repo and wire origin in one shot.
  const create = run("gh", [
    "repo",
    "create",
    "iva-vault",
    "--private",
    "--source",
    VAULT(),
    "--remote",
    "origin",
    "--push",
  ]);
  if (create.status === 0) {
    console.log(
      "brain: created private backup repo iva-vault and attached origin",
    );
    return run("git", ["remote", "get-url", "origin"]).stdout.trim();
  }

  // Repo probably already exists — just point origin at <user>/iva-vault.
  const login = run("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
  if (!login) return "";
  const url = `https://github.com/${login}/iva-vault.git`;
  run("git", ["remote", "add", "origin", url]);
  return run("git", ["remote", "get-url", "origin"]).stdout.trim();
}

const remoteUrl = ensureRemote();
if (!remoteUrl) {
  await alert(
    "vault-remote",
    "missing",
    T(
      "Memory is not backed up: the vault has no git remote. On the server run: gh auth login " +
        "(repo scope). The nightly brain then creates a private iva-vault repository and turns the backup on.",
      "Память не бэкапится: у vault нет git remote. Зайди на сервер и выполни: gh auth login " +
        "(scope repo). Ночной brain сам создаст приватный репозиторий iva-vault и включит бэкап.",
    ),
  );
}
if (remoteUrl) cleared("vault-remote");

// Перед `git add -A`: в .gitignore вольта должны быть шаблоны временных файлов атомарной
// записи, иначе огрызок убитого писателя уедет в историю памяти как карточка. Идемпотентно
// и только дозаписью — см. ensureVaultGitignore.
if (ensureVaultGitignore(VAULT()))
  console.log("brain: added temp-file patterns to the vault .gitignore");

// Локальный коммит есть всегда: без remote отменяется только push. Днём память коммитят
// сами писатели, а здесь подметальщик забирает то, что осталось незакоммиченным. Коммитит он
// тем же швом, что и день: сверка «это репозиторий самого vault» и своё окружение git не
// дают памяти уехать в чужую историю. Нет агентского дерева - коммита нет, но ночь идёт.
const swept = await loadVaultSweep(`chore: memory ${today}`, VAULT());
if (swept !== null && !swept.ok)
  console.error(`brain: vault commit failed: ${swept.reason ?? ""}`);
if (!remoteUrl) {
  console.error("brain: no remote and gh unavailable — push skipped");
  console.log("=== brain: vault committed locally, push skipped ===");
  process.exit(failures.length ? 1 : 0);
}
const push = run("git", ["push"]);
if (push.status !== 0) {
  const error = classifyGitPushError(push.stderr);
  const message =
    error.kind === "oversize"
      ? T(
          "Memory backup rejected: the vault history holds a file too big for GitHub. Nothing is " +
            "lost, but new memory stays on the server only. Clean the history by hand on the " +
            `server, in ${VAULT()}.\n` +
            "1. Start a clean branch: git checkout --orphan vault-clean\n" +
            '2. Commit the current files: git add -A && git commit -m "vault"\n' +
            "3. Replace the remote history: git push --force origin vault-clean:main",
          "Бэкап памяти отклонён: в истории vault лежит слишком большой файл. Ничего не потеряно, " +
            "но новая память остаётся только на сервере. Почисти историю вручную на сервере, " +
            `в ${VAULT()}.\n` +
            "1. Заведи чистую ветку: git checkout --orphan vault-clean\n" +
            '2. Закоммить текущие файлы: git add -A && git commit -m "vault"\n' +
            "3. Замени историю на remote: git push --force origin vault-clean:main",
        )
      : error.kind === "auth"
        ? T(
            "Memory backup failed: git has no access to the repo. New memory stays on the server " +
              `only. On the server run: gh auth login. Then check: cd ${VAULT()} && git push`,
            "Бэкап памяти не прошёл: у git нет доступа к репозиторию. Новая память остаётся только " +
              `на сервере. Выполни на сервере: gh auth login. Потом проверь: cd ${VAULT()} && git push`,
          )
        : T(
            `Memory backup failed: ${error.firstLine}. New memory stays on the server only. ` +
              `On the server run: cd ${VAULT()} && git push`,
            `Бэкап памяти не прошёл: ${error.firstLine}. Новая память остаётся только на сервере. ` +
              `Выполни на сервере: cd ${VAULT()} && git push`,
          );
  console.warn(`brain: ${message}`);
  await alert("backup-push", error.kind, message);
  process.exit(1);
}
cleared("backup-push");

console.log("=== brain: done, vault committed and pushed ===");
process.exit(failures.length ? 1 : 0);
