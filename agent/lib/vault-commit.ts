// Память под git: одна успешная правка = один локальный коммит затронутых путей в
// репозитории vault. Единственный шов, через который писатели памяти (write_card,
// write_file, ночной Rollup) оставляют след в истории; `git add -A` ночного Brain
// остаётся подметальщиком и подбирает то, что коммит сделать не смог.
//
// Замок индекса git общий на весь репозиторий, поэтому коммиты этого процесса идут по
// одному, а чужой (ночной) коммит пережидается коротким ожиданием. Замок индекса,
// брошенный убитым коммитом, опознаётся по возрасту - как замки расписаний и карточек -
// и снимается: иначе ни одна следующая правка, ни Brain больше не коммитятся.
//
// Ни один отказ здесь не роняет ход: файл уже записан, причина уходит в журнал одной
// строкой. Без remote локальные коммиты есть; push остаётся делом ночного Brain.
//
// Git зовётся своим окружением (см. gitEnv) и с литеральными путями: и то и другое - граница
// репозитория, а не удобство. Чужой GIT_DIR уводит коммит в чужую историю, а имя файла с `*`
// без литерального пути становится глобом и забирает в коммит файлы владельца.
//
// Обновлятор берёт этот модуль динамическим импортом: он обязан грузиться на установке без
// агентского дерева (scripts/authored-tree-guard.test.ts), а сам шов не ищет vault - его
// называет вызывающий, который свой vault уже разрешил.
import { execFile } from "node:child_process";
import { realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Сколько ждать освобождения индекса: сосед коммитит за десятки миллисекунд. */
const INDEX_WAIT_MS = [60, 120, 240, 480];
/** Замок старше этого возраста - огрызок убитого коммита, а не живой сосед. Порог тот же,
 * что у замка карточки. */
const INDEX_LOCK_STALE_MS = 15_000;
const INDEX_LOCK = "index.lock";
/** Потолок на один вызов git. Холодная запись на вольте из 20000 карточек занимает 2597 мс
 * (замер QA), дальше медиана 275 мс: 12 с - это тот же порядок с запасом больше четырёх раз,
 * чтобы медленный диск не отменял коммит, а висящий хук не держал запись минутами. */
const GIT_TIMEOUT_MS = 12_000;
/** Тест висящего git не ждёт боевые двенадцать секунд: потолок читается на каждом вызове. */
function gitTimeoutMs(): number {
  const override = Number(process.env.IVA_VAULT_GIT_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : GIT_TIMEOUT_MS;
}
/** В vault может не быть identity (headless VPS, свежий образ): коммитим от Ивы через
 * `-c`, конфиг владельца не трогаем. */
const IVA_IDENTITY = ["-c", "user.name=Iva", "-c", "user.email=iva@localhost"];
const REASON_CAP = 200;
const LOG_PREFIX = "[vault-commit]";
/** Бит записи индекса: файл добавлен без содержимого (`git add -N`). */
const INTENT_TO_ADD = 0x2000_0000;
/** Пустой блоб: с ним в индексе лежит и `add -N`, и честно застейдженный пустой файл. */
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const ZERO_OBJECT = "0".repeat(40);

/** Что наследуется от процесса: git ищет себя и конфиг владельца. Белый список, а не чёрный
 * список запрещённых GIT_*: чужой `GIT_DIR` (его оставляет после себя git-хук или
 * `rebase --exec`) увёл бы коммит в другой репозиторий, `GIT_INDEX_FILE` - в чужой индекс,
 * `GIT_OBJECT_DIRECTORY` - в чужую базу объектов, `GIT_CEILING_DIRECTORIES` - мимо vault. */
const GIT_ENV_KEEP =
  /^(?:PATH|HOME|TMPDIR|TMP|TEMP|USERPROFILE|SystemRoot|ComSpec|PATHEXT|LANG|LANGUAGE|TZ|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM)$|^LC_/u;

/** `GIT_LITERAL_PATHSPECS` шов ставит сам: без него имя файла с `*`, `?` или `[` становится
 * глобом и забирает в коммит соседние файлы владельца. Язык сообщений git - тоже свой: шов
 * узнаёт занятый индекс и «нечего коммитить» по английскому тексту, а на VPS с русской
 * локалью git отвечает по-русски. */
export function gitEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && GIT_ENV_KEEP.test(name)) env[name] = value;
  }
  return { ...env, GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", LANGUAGE: "C" };
}

/** Занятый индекс - это именно `File exists`; отказ по правам печатает тот же
 * `index.lock` в тексте ошибки, и ждать секунду впустую на нём нечего. */
const INDEX_BUSY =
  /index\.lock[^\n]*File exists|Another git process seems to be running/u;
const IDENTITY_MISSING = /tell me who you are|user\.name|user\.email/iu;
const NOTHING_TO_COMMIT =
  /nothing to commit|nothing added to commit|no changes added to commit/u;
/** Строка-подсказка git: она идёт после причины, и в журнал уезжала именно она. */
const HINT_LINE = /^hint:/u;

export type VaultCommit =
  | {
      readonly ok: true;
      readonly committed: boolean;
      /** Почему коммита нет, если его не должно быть (чужой репозиторий, нечего коммитить). */
      readonly reason?: string;
    }
  | { readonly ok: false; readonly reason: string };

type GitRun = {
  readonly code: number;
  readonly err: string;
  readonly out: string;
  /** Убит по таймауту: `code` при этом пуст, и без флага причина выходила ложной. */
  readonly timeout: boolean;
};

function detail(run: GitRun): string {
  return `${run.err}\n${run.out}`.trim();
}

function git(
  args: readonly string[],
  cwd: string,
  input?: string,
): Promise<GitRun> {
  return new Promise((done) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, env: gitEnv(), timeout: gitTimeoutMs(), windowsHide: true },
      (error, stdout, stderr) => {
        const failed = error !== null;
        done({
          code: failed ? exitCode(error) : 0,
          err: failed ? `${stderr}${error.message}` : stderr,
          out: stdout,
          timeout: killed(error),
        });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Убитый по таймауту процесс приходит с пустым кодом и `killed`. */
function killed(error: unknown): boolean {
  return (error as { killed?: unknown } | null)?.killed === true;
}

/** 127 у отсутствующего в PATH git: код выхода и «команды нет» - разные причины. */
function exitCode(error: unknown): number {
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : 127;
}

/** Причина отказа одной строкой: git печатает причину первой, а подсказку (`hint:`) после
 * неё, поэтому берём первую строку, которая не подсказка. */
function reasonOf(run: GitRun): string {
  if (run.timeout)
    return `git не ответил за ${String(gitTimeoutMs() / 1000)} с`;
  if (run.code === 127) return "git не найден в PATH";
  const lines = detail(run)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !HINT_LINE.test(line));
  return (lines[0] ?? `git вышел с кодом ${String(run.code)}`).slice(
    0,
    REASON_CAP,
  );
}

const sleep = (ms: number) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** Брошенный замок индекса снимаем, живой не трогаем. Возврат: что-то сняли. */
function clearStaleIndexLock(vault: string): boolean {
  const lock = join(vault, ".git", INDEX_LOCK);
  try {
    if (Date.now() - statSync(lock).mtimeMs < INDEX_LOCK_STALE_MS) return false;
  } catch {
    return false;
  }
  try {
    rmSync(lock, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Занятый индекс - не отказ правки: короткое ожидание, снятие огрызка, повтор. */
async function withIndexRetry(
  vault: string,
  run: () => Promise<GitRun>,
): Promise<GitRun> {
  let result = await run();
  if (result.code === 0 || !INDEX_BUSY.test(detail(result))) return result;
  if (clearStaleIndexLock(vault)) result = await run();
  for (const wait of INDEX_WAIT_MS) {
    if (result.code === 0 || !INDEX_BUSY.test(detail(result))) return result;
    await sleep(wait);
    result = await run();
  }
  return result;
}

/** Коммит от Ивы, если в vault нет identity владельца. Пути названы и здесь: коммит без
 * pathspec забирает весь индекс, а индекс в vault общий с владельцем. */
async function commitWith(
  vault: string,
  message: string,
  paths: readonly string[],
): Promise<GitRun> {
  const plain = await git(
    ["commit", "-q", "-m", message, "--", ...paths],
    vault,
  );
  if (plain.code === 0 || !IDENTITY_MISSING.test(detail(plain))) return plain;
  return git(
    [...IVA_IDENTITY, "commit", "-q", "-m", message, "--", ...paths],
    vault,
  );
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Путь в виде, который понимает `git add`, или null - путь вне vault. Удалённый файл
 * реального пути не имеет, поэтому его берём как есть: символической ссылки вне vault
 * у него быть не может. */
function vaultPath(vault: string, path: string): string | null {
  const full = resolve(path);
  const real = realOf(full) ?? full;
  const rel = relative(vault, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

type RepoCheck =
  { readonly kind: "own" } | { readonly kind: "skip"; readonly reason: string };

/** Положительный ответ про свой репозиторий не меняется: он уже есть вокруг vault. Кэш снимает
 * спавн `rev-parse` с каждой записи. Отрицательный ответ не кэшируется - репозиторий вокруг
 * каталога может появиться позже (`git init` в vault, `init-vault`). */
const ownRepositories = new Set<string>();

/** Свой ли это репозиторий: шов коммитит только в vault, иначе память легла бы в историю
 * репозитория кода, который двигает обновлятор. Отказ git называет себя сам, а найденный
 * корень выше vault называем как есть: он не обязательно чужой, но коммитить в него нельзя. */
async function checkRepository(vault: string): Promise<RepoCheck> {
  if (ownRepositories.has(vault)) return { kind: "own" };
  const run = await git(["rev-parse", "--show-toplevel"], vault);
  if (run.code !== 0) return { kind: "skip", reason: reasonOf(run) };
  const root = run.out.trim();
  const owner = realOf(root) ?? root;
  if (owner === vault) {
    ownRepositories.add(vault);
    return { kind: "own" };
  }
  return { kind: "skip", reason: `репозиторий выше vault: ${owner}` };
}

/** Запись индекса по нашему пути в снимке: что вернуть, если коммит не состоялся. */
type IndexEntry = {
  readonly intentToAdd: boolean;
  /** Строка `ls-files -s -z` целиком: её же понимает `update-index --index-info`. */
  readonly record: string;
};

/** Помета «добавлено без содержимого» видна только в флагах записи индекса: в снимке её надо
 * сохранить, иначе после неудачного коммита чужой `git add -N` превращается в застейдженный
 * пустой файл и следующий коммит уносит его пустым. */
async function markedIntentToAdd(
  vault: string,
  path: string,
): Promise<boolean> {
  const run = await git(["ls-files", "--debug", "--", path], vault);
  const flags = /flags: ([0-9a-f]+)/u.exec(run.out)?.[1];
  return (
    flags !== undefined && (Number.parseInt(flags, 16) & INTENT_TO_ADD) !== 0
  );
}

/** Записи индекса по нашим путям до `git add`, или null - индекс прочитать не удалось. Без
 * снимка лучше не трогать индекс вовсе, чем вернуть его наугад. */
async function indexEntries(
  vault: string,
  paths: readonly string[],
): Promise<Map<string, IndexEntry> | null> {
  const run = await git(["ls-files", "-s", "-z", "--", ...paths], vault);
  if (run.code !== 0) return null;
  const entries = new Map<string, IndexEntry>();
  for (const record of run.out.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const path = record.slice(tab + 1);
    const object = record.slice(0, tab).split(" ")[1];
    const empty =
      object === EMPTY_BLOB && (await markedIntentToAdd(vault, path));
    entries.set(path, { intentToAdd: empty, record });
  }
  return entries;
}

/** Вернуть индекс по нашим путям как было: одной пачкой, снимком записей. Чужой индекс (другие
 * пути) не трогаем - он не наш; путь, которого в снимке не было, снимается нулевым режимом, а
 * стадии конфликта слияния возвращаются тем же форматом, в каком лежали. */
async function restoreIndex(
  vault: string,
  paths: readonly string[],
  before: ReadonlyMap<string, IndexEntry>,
): Promise<void> {
  const payload: string[] = [];
  const intent: string[] = [];
  for (const path of paths) {
    const entry = before.get(path);
    // Помета «без содержимого» снимается вместе с записью: `git add -N` поверх уже
    // застейдженного файла - это no-op, поэтому сначала убираем нашу запись, потом ставим
    // помету заново.
    if (entry !== undefined && !entry.intentToAdd)
      payload.push(`${entry.record}\0`);
    else {
      payload.push(`0 ${ZERO_OBJECT}\t${path}\0`);
      if (entry !== undefined) intent.push(path);
    }
  }
  if (payload.length > 0)
    await git(["update-index", "-z", "--index-info"], vault, payload.join(""));
  for (const path of intent) await git(["add", "-N", "--", path], vault);
}

function vaultRoot(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

/** Коммиты этого процесса идут по одному: два параллельных `git add` одного хода бились
 * бы за общий индекс, а он принадлежит всему репозиторию. */
let commitQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const queued = commitQueue.then(task, task);
  commitQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function commitPaths(
  vault: string,
  message: string,
  paths: readonly string[],
): Promise<VaultCommit> {
  const repo = await checkRepository(vault);
  if (repo.kind === "skip")
    return { ok: true, committed: false, reason: repo.reason };
  const before = await indexEntries(vault, paths);
  const staged = await withIndexRetry(vault, () =>
    git(["add", "--", ...paths], vault),
  );
  if (staged.code !== 0) {
    // `git add` стейджит часть путей до отказа (игнорируемый путь, пропавший путь), поэтому
    // индекс возвращается и здесь, а не только на отказе коммита.
    if (before !== null) await restoreIndex(vault, paths, before);
    return { ok: false, reason: reasonOf(staged) };
  }
  const committed = await withIndexRetry(vault, () =>
    commitWith(vault, message, paths),
  );
  if (committed.code === 0) return { ok: true, committed: true };
  // Коммит не состоялся (hook, отказ git): бросок не должен остаться в индексе, иначе его
  // подметёт чужой коммит или следующий наш.
  if (before !== null) await restoreIndex(vault, paths, before);
  // Правка не изменила ни одного байта - коммитить нечего, и это не отказ.
  if (NOTHING_TO_COMMIT.test(detail(committed)))
    return { ok: true, committed: false };
  return { ok: false, reason: reasonOf(committed) };
}

/**
 * Закоммитить правку памяти: сообщение вида `card <slug>: UPDATE`, `file <путь>: write`
 * и пути, которые эта правка затронула. Пути вне vault молча пропускаются, отказ git
 * уходит в журнал одной строкой и никогда не роняет ход. `root` - тот vault, о котором
 * идёт речь: шов его не угадывает, а получает от вызывающего, который уже знает свой.
 */
export async function commitVaultWrite(
  message: string,
  paths: readonly string[],
  root: string,
): Promise<VaultCommit> {
  const vault = vaultRoot(root);
  const rel =
    vault === null
      ? []
      : paths
          .map((path) => vaultPath(vault, path))
          .filter((path): path is string => path !== null);
  if (vault === null || rel.length === 0) return { ok: true, committed: false };
  const outcome = await serialized(() => commitPaths(vault, message, rel));
  if (outcome.reason !== undefined)
    console.error(`${LOG_PREFIX} ${message}: ${outcome.reason}`);
  return outcome;
}

/** Ночной подметальщик: закоммитить всё незакоммиченное в vault - днём это делают писатели, а
 * он подбирает то, что осталось. Механизм тот же, что у правки: свой репозиторий, своё
 * окружение, пути литералами. */
export async function commitVaultSweep(
  message: string,
  root: string,
): Promise<VaultCommit> {
  const paths = await changedVaultPaths(root);
  if (paths.length === 0) return { ok: true, committed: false };
  return await commitVaultWrite(message, paths, root);
}

/** Снимок «до» и результат «после» чужой работы над vault: чистку карточек делает не
 * агент, а чужой процесс (обновлятор ждёт её, меню узнаёт о конце ходом раннера), поэтому
 * шов отдаёт две половины пары, а не оборачивает работу. Обе половины называют только
 * затронутые пути и не роняют вызвавшего; имена коммитов собираются здесь, чтобы у обоих
 * потребителей они были одной формы. */
export interface VaultWritePair {
  readonly after: () => Promise<void>;
  readonly before: () => Promise<void>;
}

export function vaultWritePair(label: string, root: string): VaultWritePair {
  const commit = async (what: string): Promise<void> => {
    const paths = await changedVaultPaths(root);
    if (paths.length > 0)
      await commitVaultWrite(`${label}: vault ${what}`, paths, root);
  };
  return { after: () => commit("cleanup"), before: () => commit("snapshot") };
}

/** Записи-статуса git без кавычек: с `-z` пути идут как есть, переименование несёт два. */
function statusPaths(output: string): string[] {
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[1] === "R") index += 1;
  }
  return paths;
}

/** Незакоммиченные пути vault: паре нужен снимок «до» и результат работы, а `add -A` в шве
 * запрещён - коммит обязан называть свои пути. */
async function changedVaultPaths(root: string): Promise<string[]> {
  const vault = vaultRoot(root);
  if (vault === null) return [];
  const run = await git(["status", "--porcelain", "-z"], vault);
  if (run.code !== 0) return [];
  return statusPaths(run.out).map((path) => join(vault, path));
}
