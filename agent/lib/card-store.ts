// Хранилище карточек: поиск существующего файла по идентичности, слияние (merge)
// нового содержимого со старым, лок + атомарная запись.
//
// Инвариант: write_card сохраняет неизвестные поля frontmatter и created. UPDATE
// дополняет один ## Log, SUPERSEDE заменяет Compiled Truth и переносит прежний факт
// в ## History, а NOOP не пишет файл.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasUnclosedFence, outsideFences, scanFences } from "./card-text.ts";
import {
  acquireFileLock,
  releaseFileLock,
  writeFileAtomicSync,
} from "./fs-atomic.ts";
import {
  parseFrontmatter,
  parseFrontmatterOrSkip,
  writeFrontmatter,
  type FmFields,
  type FmValue,
} from "./frontmatter.js";

export { outsideFences } from "./card-text.ts";

// ─── identity ──────────────────────────────────────────────────────────────

/** Слаг файла: кириллица сохраняется (vault хранит её нормально), пунктуация → дефис. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "card"
  );
}

/** Нормализация имени: без пунктуации, lowercase; скобки сохраняют содержимое. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Имя без уточнения в скобках — для матча «голое имя ↔ квалифицированная карточка». */
export function baseName(s: string): string {
  return normalizeName(s.replace(/\([^)]*\)/g, " "));
}

const hasQualifier = (s: string) => /\(/.test(s);

export function extractH1(body: string): string | null {
  const lines = body.split("\n");
  const outside = outsideFences(lines);
  const line = lines.find(
    (candidate, index) => outside[index] && /^ {0,3}#\s+/.test(candidate),
  );
  const m = line ? /^ {0,3}#\s+(.+)$/.exec(line) : null;
  return m ? m[1].trim() : null;
}

function fmNames(fields: FmFields | null): string[] {
  if (!fields) return [];
  const out: string[] = [];
  for (const key of ["name", "title", "aka", "aliases"]) {
    const v = fields[key];
    if (!v) continue;
    if (Array.isArray(v)) out.push(...v);
    else
      out.push(
        ...String(v)
          .split(",")
          .map((x) => x.trim()),
      );
  }
  return out.filter(Boolean);
}

export interface Identity {
  /** Абсолютный/относительный путь файла карточки (может ещё не существовать). */
  file: string;
  /** Файл найден по H1/name/aliases, а не по точному слагу (легаси-слаг). */
  matchedBy: "slug" | "title" | "new";
  /** Несколько кандидатов — писать нельзя, нужен выбор человека/модели. */
  candidates?: string[];
}

// Имена одной карточки в уже нормализованном виде — вместе со снимком файла, по которому
// видно, что разбирать её заново не нужно.
interface CardNames {
  mtimeNs: bigint;
  size: bigint;
  /** normalizeName каждого кандидата (H1, name/title/aka/aliases, слаг файла). */
  full: string[];
  /** baseName тех же кандидатов — для матча «голое имя ↔ квалифицированная карточка». */
  bare: string[];
}

// Промах точного слага — это КАЖДАЯ новая карточка, а за ночь ролловера их десятки.
// Без кэша каждая из них перечитывала и разбирала весь каталог типа: N карточек → N²
// чтений с диска. Кэш живёт в процессе, по каталогу; ключ записи — снимок файла (mtime в
// наносекундах + размер), поэтому правка карточки чужими руками (ночной Brain, git pull)
// видна так же, как своя.
//
// Что осталось и почему: обход никуда не делся — на каждый промах это readdirSync плюс
// statSync на файл, то есть O(N) СИСТЕМНЫХ ВЫЗОВОВ (ушли только чтение содержимого и
// разбор frontmatter, самая дорогая часть). Это осознанная цена: карточки пишет не
// только этот процесс, и единственный способ увидеть чужую правку — спросить у диска.
// Замеры на 2000 карточек, 50 промахов подряд: 5283 мс → 1143 мс, и весь остаток —
// как раз эти stat'ы.
const namesByDir = new Map<string, Map<string, CardNames>>();

// Счётчики для тестов: сколько карточек реально прочитано с диска при разрешении имени.
export const resolveStats = { fileReads: 0 };

function cardNames(dir: string): Map<string, CardNames> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    names = [];
  }
  const cached = namesByDir.get(dir) ?? new Map<string, CardNames>();
  const fresh = new Map<string, CardNames>();
  for (const name of names.sort()) {
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full, { bigint: true });
    } catch {
      continue; // файл исчез между листингом и снимком
    }
    const prior = cached.get(name);
    if (prior && prior.mtimeNs === stats.mtimeNs && prior.size === stats.size) {
      fresh.set(name, prior);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    resolveStats.fileReads++;
    // Соседняя карточка со сломанным frontmatter не имеет права уронить разбор
    // всего каталога: её просто не найти по заголовку, остальные на месте.
    const parsed = parseFrontmatterOrSkip(text, full);
    if (parsed === null) continue;
    const { fields, body } = parsed;
    const h1 = extractH1(body);
    const cands = [h1, ...fmNames(fields), name.replace(/\.md$/, "")].filter(
      Boolean,
    ) as string[];
    fresh.set(name, {
      mtimeNs: stats.mtimeNs,
      size: stats.size,
      full: cands.map(normalizeName),
      bare: cands.map(baseName),
    });
  }
  namesByDir.set(dir, fresh);
  return fresh;
}

/**
 * Идентичность карточки: сначала точный слаг, иначе — поиск среди карточек ТОГО ЖЕ типа
 * по H1-заголовку и полям name/title/aka/aliases. Так карточка с латинским легаси-слагом
 * (yasmin.md) и кириллическим H1 («Ясмин …») находится, а не дублируется.
 * Несколько кандидатов → candidates, вызывающий обязан отказаться от записи.
 */
export function resolveCard(dir: string, title: string): Identity {
  const slug = slugify(title);
  const exact = join(dir, `${slug}.md`);
  if (existsSync(exact)) return { file: exact, matchedBy: "slug" };

  // Правило квалификаторов: «Ясмин» (без скобок) находит «Ясмин (AI Content Creator)»,
  // но «Alex (UK)» НЕ сливается в «Alex (US)» — квалифицированный запрос матчится только
  // при полном совпадении (со скобками), иначе это другая сущность и нужен новый файл.
  const wanted = normalizeName(title);
  const wantedBase = baseName(title);
  const bareQuery = !hasQualifier(title);
  const hits: string[] = [];
  for (const [name, entry] of cardNames(dir)) {
    const matched =
      entry.full.includes(wanted) ||
      (bareQuery && entry.bare.includes(wantedBase));
    if (matched) hits.push(join(dir, name));
  }

  if (hits.length === 1) return { file: hits[0], matchedBy: "title" };
  if (hits.length > 1)
    return { file: exact, matchedBy: "new", candidates: hits };
  return { file: exact, matchedBy: "new" };
}

// ─── merge ─────────────────────────────────────────────────────────────────

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Канонические записи Log. Неоднозначная секция не даёт совпадений: лишний дубль
 * безопаснее потери нового факта. Однострочная запись хранит факт после даты;
 * многострочная — под датным буллетом с отступом ровно на два пробела.
 */
function logFacts(body: string): string[] {
  const lines = body.split("\n");
  const sections = h2Sections(lines, "Log");
  if (sections.length !== 1) return [];

  const raw = lines.slice(sections[0].start + 1, sections[0].end);
  while (raw.length && !raw[0].trim()) raw.shift();
  while (raw.length && !raw.at(-1)?.trim()) raw.pop();

  const facts: string[] = [];
  for (let index = 0; index < raw.length;) {
    const marker = /^- \d{4}-\d{2}-\d{2}:(?: (.*))?$/.exec(raw[index]);
    if (!marker) return [];

    if (marker[1] !== undefined) {
      facts.push(marker[1]);
      index++;
      if (index < raw.length && /^ {2}/.test(raw[index])) return [];
      continue;
    }

    index++;
    const continuation: string[] = [];
    while (index < raw.length && !/^- \d{4}-\d{2}-\d{2}:/.test(raw[index])) {
      if (!/^ {2}/.test(raw[index])) return [];
      continuation.push(raw[index].slice(2));
      index++;
    }
    if (!continuation.length) return [];
    facts.push(continuation.join("\n"));
  }
  return facts;
}

/**
 * Уже ли новый факт равен одной структурной записи карточки. Подстрока не считается
 * дублем: сверяем только всю Compiled Truth или всю однозначно разобранную запись Log.
 */
export function bodyContains(existingBody: string, incoming: string): boolean {
  const wanted = norm(incoming);
  if (!wanted) return true;
  return [compiledTruth(existingBody), ...logFacts(existingBody)].some(
    (fact) => norm(fact) === wanted,
  );
}

interface H2Section {
  start: number;
  end: number;
}

interface NamedH2Section extends H2Section {
  heading: string;
  key: string;
}

export function h2Sections(lines: string[], heading: string): H2Section[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wanted = new RegExp(`^ {0,3}##\\s+${escaped}\\s*$`, "i");
  const outside = outsideFences(lines);
  const starts = lines.flatMap((line, index) =>
    outside[index] && wanted.test(line) ? [index] : [],
  );
  return starts.map((start) => {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (outside[index] && /^ {0,3}#{1,2}\s+/.test(lines[index])) {
        end = index;
        break;
      }
    }
    return { start, end };
  });
}

function hasH2Section(body: string, heading: string): boolean {
  return h2Sections(body.split("\n"), heading).length > 0;
}

function hasOutsideHeading(body: string, pattern: RegExp): boolean {
  const lines = body.split("\n");
  const outside = outsideFences(lines);
  return lines.some((line, index) => outside[index] && pattern.test(line));
}

function namedH2Sections(lines: string[]): NamedH2Section[] {
  const outside = outsideFences(lines);
  const starts = lines.flatMap((line, index) => {
    if (!outside[index]) return [];
    const match = /^ {0,3}##\s+(.+?)\s*$/.exec(line);
    return match
      ? [{ start: index, heading: match[1].trim(), key: norm(match[1]) }]
      : [];
  });
  return starts.map(({ start, heading, key }) => {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (outside[index] && /^ {0,3}#{1,2}\s+/.test(lines[index])) {
        end = index;
        break;
      }
    }
    return { start, end, heading, key };
  });
}

function normalizeRelatedTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("|", 1)[0]
    .split("#", 1)[0]
    .trim()
    .toLowerCase();
}

function replaceH2Sections(
  body: string,
  heading: string,
  content: string[],
): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, heading);
  // Heading, blank line, entries - the shape the rest of the card already uses, so a
  // rewritten section never ends up glued to the next heading.
  const canonical = [`## ${heading}`, "", ...content];
  if (!sections.length) {
    return `${body.replace(/\s+$/, "")}\n\n${canonical.join("\n")}\n`;
  }

  const first = sections[0].start;
  const byStart = new Map(
    sections.map((section) => [section.start, section.end]),
  );
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const end = byStart.get(index);
    if (end !== undefined) {
      if (index === first) output.push(...canonical, "");
      index = end;
      continue;
    }
    output.push(lines[index]);
    index++;
  }
  return output.join("\n").replace(/\s+$/, "") + "\n";
}

/** Keep exactly one Related section and deduplicate targets ignoring alias/anchor. */
export function mergeRelated(body: string, related: string[]): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, "Related");
  const seen = new Set<string>();
  const links: string[] = [];
  const prose: string[] = [];

  for (const section of sections) {
    for (const line of lines.slice(section.start + 1, section.end)) {
      if (!line.trim()) continue;
      const matches = [...line.matchAll(/\[\[([^\]]+)\]\]/g)];
      const remainder = line
        .replace(/\[\[[^\]]+\]\]/g, "")
        .replace(/[-*·,;:\s]/g, "");
      if (matches.length && !remainder) {
        for (const match of matches) {
          const target = normalizeRelatedTarget(match[1]);
          if (!target || seen.has(target)) continue;
          seen.add(target);
          links.push(match[1].trim());
        }
      } else {
        prose.push(line);
        for (const match of matches) seen.add(normalizeRelatedTarget(match[1]));
      }
    }
  }

  for (const raw of related) {
    const display = raw.trim().replace(/^\[\[|\]\]$/g, "");
    const target = normalizeRelatedTarget(display);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    links.push(display);
  }

  if (!sections.length && !prose.length && !links.length) return body;
  const content = [...prose, ...links.map((link) => `- [[${link}]]`)];
  return replaceH2Sections(body, "Related", content);
}

/** Строки секции как они лежат в карточке. Пустая строка внутри уже сохранённой записи -
 * часть свидетельства (пустая строка в фенсе с кодом, в транскрипте, в diff), а не
 * форматирование, поэтому выкусываются только пустые строки на границах секции: иначе
 * следующий UPDATE, пересобирая Log, задним числом правит чужую запись. */
function sectionContent(body: string, heading: string): string[] {
  const lines = body.split("\n");
  return h2Sections(lines, heading).flatMap((section) => {
    const content = lines.slice(section.start + 1, section.end);
    while (content.length && !content[0].trim()) content.shift();
    while (content.length && !content.at(-1)?.trim()) content.pop();
    return content;
  });
}

function removeH2Sections(body: string, heading: string): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, heading);
  if (!sections.length) return body;
  const byStart = new Map(
    sections.map((section) => [section.start, section.end]),
  );
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const end = byStart.get(index);
    if (end !== undefined) {
      index = end;
      continue;
    }
    output.push(lines[index]);
    index++;
  }
  return output.join("\n").replace(/\s+$/, "") + "\n";
}

/** История хранится как `- YYYY-MM-DD: факт`. Дата, которую назвала модель, считается
 * своей независимо от буллета — иначе навсегда уезжает вторая дата поверх первой. Строку
 * без даты датируем днём записи. */
function canonicalHistoryEntry(historyEntry: string, date: string): string {
  const entry = historyEntry.trim().replace(/^[-*]\s+/, "");
  return /^\d{4}-\d{2}-\d{2}:/.test(entry)
    ? `- ${entry}`
    : `- ${date}: ${entry}`;
}

/** Строка History для вытесненного описания: дату ставит только код — день записи. Значение
 * едет данными: перевод строки схлопывается в пробел, а ведущие `-`, `#` и дата в начале
 * значения ничего не значат и второй строки не рождают. */
function displacedHistoryEntry(value: string, date: string): string {
  return `- ${date}: ${value.replace(/\s+/gu, " ").trim()}`;
}

/** Тот же факт по существу: регистр, ё/е, пробелы и знаки значения не имеют, а порядок слов
 * имеет («с 5 до 9» и «с 9 до 5» — противоположные факты). */
function sameFact(left: string, right: string): boolean {
  return comparableFact(left) === comparableFact(right);
}

/** Прежнее значение frontmatter-половины Compiled Truth, если вызов вытесняет его по
 * существу. null — вытеснять нечего: значения нет, факт тот же, или такая формулировка уже
 * лежит в History. */
function displacedDescription(
  previous: FmValue | undefined,
  next: FmValue | undefined,
  history: string[],
): string | null {
  if (typeof previous !== "string" || typeof next !== "string") return null;
  const old = previous.trim();
  if (!old || !next.trim() || sameFact(old, next)) return null;
  return history.some((line) => sameFact(historyFact(line), old)) ? null : old;
}

/** Дописать факт в ## History одной строкой. Секцию не пересобираем: чужие строки (ручной
 * абзац, легаси-буллет) остаются как лежат, а карточка с двумя History не сливается задним
 * числом — границы такой секции неоднозначны, и решать за человека, где она кончается,
 * нечем. Дописываем в последнюю из них; пустая секция получает ту же форму, что и раньше:
 * заголовок, пустая строка, строки. */
function appendHistory(body: string, fact: string, date: string): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, "History");
  const entry = displacedHistoryEntry(fact, date);
  if (!sections.length) return replaceH2Sections(body, "History", [entry]);
  const last = sections[sections.length - 1];
  let at = last.end;
  while (at > last.start + 1 && !lines[at - 1].trim()) at--;
  const rest = lines.slice(at);
  const inserted = [
    ...(at === last.start + 1 ? [""] : []),
    entry,
    ...(rest.length && rest[0].trim() ? [""] : []),
  ];
  return [...lines.slice(0, at), ...inserted, ...rest]
    .join("\n")
    .replace(/\s*$/, "")
    .concat("\n");
}

/** Frontmatter-половина Compiled Truth не меняется молча: прежнее описание уходит в
 * append-only ## History датированной строкой (см. displacedDescription). */
function archiveDisplacedDescription(
  body: string,
  previous: FmValue | undefined,
  next: FmValue | undefined,
  date: string,
): string {
  const displaced = displacedDescription(previous, next, historyEntries(body));
  return displaced ? appendHistory(body, displaced, date) : body;
}

/** Строки-факты append-only архива. Пусто, если ## History нет или их несколько: границы
 * архива неоднозначны, судить по нему нельзя. */
function historyEntries(body: string): string[] {
  const lines = body.split("\n");
  const sections = h2Sections(lines, "History");
  if (sections.length !== 1) return [];
  return lines
    .slice(sections[0].start + 1, sections[0].end)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Текст факта без буллета и без ведущей даты записи - общая форма для сверки
 * с хвостом Истории. Дата в хвосте необязательна: строки, оставленные легаси-картой
 * или механическим слиянием autograph, приходят без неё. */
function historyFact(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d{4}-\d{2}-\d{2}:\s*/, "");
}

/** Compiled Truth лежащей карточки: всё до первой H2, без строки H1. Именно этот факт
 * вытесняет SUPERSEDE, и именно его обязан назвать historyEntry. */
function compiledTruth(body: string): string {
  const lines = body.split("\n");
  const sections = namedH2Sections(lines);
  const head = lines.slice(
    0,
    sections.length ? sections[0].start : lines.length,
  );
  const outside = outsideFences(head);
  return head
    .filter((line, index) => !(outside[index] && /^ {0,3}#\s+\S/.test(line)))
    .join("\n");
}

/** Обрамляющая пунктуация предложения — то единственное из знаков, что смысла не несёт.
 * Знаки внутри (`+`, `-`, `<`, `>`, `=`, `%`, `$`, эмодзи) в неё не входят: «рост +12» и
 * «рост -12» — противоположные факты, и выкусывание знака теряло смену факта без следа. */
const EDGE_PUNCTUATION = /^[.,;:!?…"'«»()]+|[.,;:!?…"'«»()]+$/gu;

/** Факт в форме, пригодной для сверки: без регистра, ё/е, лишних пробелов и обрамляющей
 * пунктуации. Модель пересказывает вытесненный факт своими знаками препинания и буквой ё,
 * и побайтовая сверка спотыкалась бы о точку в конце. Пунктуация по краям СЛОВА не значима,
 * внутри слова (`1.5`, `9:30`, `5-9`) — значима. Порядок слов сохраняется. */
function comparableFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/\s+/u)
    .map((word) => word.replace(EDGE_PUNCTUATION, ""))
    .filter(Boolean)
    .join(" ");
}

/** historyEntry в той же форме, но без буллета и без датного префикса: дата принадлежит
 * архиву, а не факту, и пишут её как придётся - `2026-08-09:`, `2026:`, `2026-01→08:`. */
function displacedFact(historyEntry: string): string {
  return comparableFact(
    historyEntry
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\d[\d\s./→–—-]*:\s*/, ""),
  );
}

/** Ровно та строка History, которую подал бы этот вызов: датированную сверяем целиком,
 * недатированную — по тексту факта. Так решается, реплей это или новое вытеснение. */
function repeatsArchivedFact(
  historyEntry: string,
  dated: string,
  history: string[],
): boolean {
  const fact = historyEntry.trim().replace(/^[-*]\s+/, "");
  const undated = !/^\d{4}-\d{2}-\d{2}:/.test(fact);
  return history.some(
    (entry) =>
      entry.trim() === dated.trim() || (undated && historyFact(entry) === fact),
  );
}

/** Строка History уже про этот факт (дата принадлежит записи, а не факту: два разных дня
 * у одного факта — не два вытеснения, а один факт дважды). Сверяем по всему ## History, а
 * не по хвосту: доставленный не по порядку SUPERSEDE вытесняет факт, записанный несколько
 * шагов назад, и по одному хвосту он неотличим от нового. */
function repeatsHistoryFact(historyEntry: string, history: string[]): boolean {
  const fact = comparableFact(historyFact(historyEntry));
  return history.some((entry) => comparableFact(historyFact(entry)) === fact);
}

/** Ту же запись о факте, но взятую из History: прошлый вызов уже положил её туда сам, и
 * дата принадлежит той записи, а не этому вызову. Отдаём ровно лежащую строку, чтобы
 * повтор узнавался одним правилом, а не писался второй раз под новой датой. */
function archivedHistoryEntry(
  historyEntry: string | undefined,
  oldBody: string,
  operation: CardOperation,
): string | undefined {
  if (operation !== "SUPERSEDE" || !historyEntry?.trim()) return historyEntry;
  if (!displacedFactNames(operation, historyEntry, oldBody))
    return historyEntry;
  const history = historyEntries(oldBody);
  if (!repeatsHistoryFact(historyEntry, history)) return historyEntry;
  const fact = comparableFact(historyFact(historyEntry));
  return (
    history.find((line) => comparableFact(historyFact(line)) === fact) ??
    historyEntry
  );
}

/** Многострочное тело ложится под буллет Log со сдвигом на два пробела. Судить его надо
 * ровно в этом виде: сдвиг меняет разметку, а карточка хранит результат сдвига. */
function logEntryLines(incoming: string, date: string): string[] {
  const incomingLines = incoming.trim().split("\n");
  return incomingLines.length === 1
    ? [`- ${date}: ${incomingLines[0]}`]
    : [`- ${date}:`, ...incomingLines.map((line) => `  ${line}`)];
}

function appendLog(body: string, incoming: string, date: string): string {
  const oldEntries = sectionContent(body, "Log");
  const withoutLogs = removeH2Sections(body, "Log");
  return replaceH2Sections(withoutLogs, "Log", [
    ...oldEntries,
    logEntryLines(incoming, date).join("\n"),
  ]);
}

function collapseLogSections(body: string): string {
  const lines = body.split("\n");
  if (h2Sections(lines, "Log").length <= 1) return body;
  return replaceH2Sections(body, "Log", sectionContent(body, "Log"));
}

interface CompiledTruthResult {
  body: string;
  /** То же самое уже лежит в ## History, поэтому строка НЕ дописана. */
  suppressedAgainstArchive: boolean;
}

function replaceCompiledTruth(
  oldBody: string,
  replacement: string,
  historyEntry: string | undefined,
  date: string,
): CompiledTruthResult {
  const structural = new Set(["log", "history", "related"]);
  const oldLines = oldBody.split("\n");
  const replacementLines = replacement.split("\n");
  const oldSections = namedH2Sections(oldLines);
  const replacementSections = namedH2Sections(replacementLines);
  const replacementKeys = new Set(
    replacementSections.map((section) => section.key),
  );

  // The replacement owns Compiled Truth. Structural archives remain append-only,
  // and an old custom H2 survives unless the replacement explicitly names it.
  const replacementStructuralStarts = new Map(
    replacementSections
      .filter((section) => structural.has(section.key))
      .map((section) => [section.start, section.end]),
  );
  const truthLines: string[] = [];
  for (let index = 0; index < replacementLines.length;) {
    const end = replacementStructuralStarts.get(index);
    if (end !== undefined) {
      index = end;
      continue;
    }
    truthLines.push(replacementLines[index]);
    index++;
  }

  const blocks = oldSections
    .filter(
      (section) =>
        structural.has(section.key) || !replacementKeys.has(section.key),
    )
    .map((section) => ({
      key: section.key,
      heading: section.heading,
      lines: oldLines.slice(section.start, section.end),
    }));

  const additions = new Map<string, string[]>();
  for (const section of replacementSections.filter((candidate) =>
    structural.has(candidate.key),
  )) {
    let content = replacementLines.slice(section.start + 1, section.end);
    while (content.length && !content.at(-1)?.trim()) content.pop();
    if (section.key === "history") {
      const oldHistory = oldSections.filter(
        (candidate) => candidate.key === "history",
      );
      const newHistory = replacementSections.filter(
        (candidate) => candidate.key === "history",
      );
      if (oldHistory.length > 1 || newHistory.length > 1) {
        throw new Error(
          "SUPERSEDE requires exactly one unambiguous ## History section",
        );
      }
      // История сравнивается по строкам-фактам: пустая строка между буллетами -
      // форматирование, а не свидетельство, и не должна ни ломать сверку префикса,
      // ни копиться в архиве.
      const entries = content.filter((line) => line.trim());
      if (!entries.length) {
        throw new Error(
          "SUPERSEDE replacement ## History must contain the displaced fact",
        );
      }
      content = entries;
      if (oldHistory.length === 1) {
        const oldEntries = oldLines
          .slice(oldHistory[0].start + 1, oldHistory[0].end)
          .filter((line) => line.trim());
        const prefixMatches = oldEntries.every(
          (line, index) => entries[index]?.trim() === line.trim(),
        );
        if (!prefixMatches) {
          throw new Error(
            "SUPERSEDE replacement ## History must preserve existing History as an exact prefix",
          );
        }
        content = entries.slice(oldEntries.length);
        if (!content.length && !historyEntry?.trim()) {
          throw new Error(
            "SUPERSEDE replacement ## History must append the displaced fact",
          );
        }
      }
    }
    if (content.some((line) => line.length)) {
      additions.set(section.key, [
        ...(additions.get(section.key) ?? []),
        ...content,
      ]);
    }
  }
  let suppressedAgainstArchive = false;
  if (historyEntry?.trim()) {
    const dated = canonicalHistoryEntry(historyEntry, date);
    const pending = additions.get("history") ?? [];
    // Один вытесненный факт - одна строка. Модель, дописавшая ## History в body
    // (секция принадлежит write_card), и повторная доставка уже выполненного вызова
    // подают тот же факт вторым путём; архив решает, новый он или нет. Легаси-путь
    // сверяется с подаваемым суффиксом: там факт пишется телом, терять нечего.
    const archived = pending.length
      ? [pending.at(-1) as string]
      : historyEntries(oldBody);
    if (repeatsArchivedFact(historyEntry, dated, archived)) {
      // Совпал с лежащим архивом - строки нет ни в одном пути записи, и вызывающий
      // обязан убедиться, что это реплей, а не потеря факта.
      suppressedAgainstArchive = pending.length === 0;
    } else {
      additions.set("history", [...pending, dated]);
    }
  }

  for (const [key, lines] of additions) {
    let block = [...blocks]
      .reverse()
      .find((candidate) => candidate.key === key);
    if (!block) {
      const heading =
        key === "history" ? "History" : key === "log" ? "Log" : "Related";
      block = { key, heading, lines: [`## ${heading}`] };
      blocks.push(block);
    }
    // Blank line after the heading, none between entries: otherwise every SUPERSEDE
    // adds one more blank to the archive and the list renders loose.
    while (block.lines.length > 1 && !block.lines.at(-1)?.trim())
      block.lines.pop();
    if (/^ {0,3}#{1,6}\s/.test(block.lines.at(-1) ?? "")) block.lines.push("");
    block.lines.push(...lines);
  }

  const output = [...truthLines];
  while (output.length && !output.at(-1)?.trim()) output.pop();
  for (const block of blocks) {
    if (output.length && output.at(-1)?.trim()) output.push("");
    output.push(...block.lines);
  }
  return {
    body: output.join("\n").replace(/\s+$/, "") + "\n",
    suppressedAgainstArchive,
  };
}

export type CardOperation = "ADD" | "UPDATE" | "SUPERSEDE" | "NOOP";
export const HISTORY_ENTRY_CAP = 500;

interface OperationInput {
  /** Операция, названная вызывающим; undefined — легаси-вызов без operation. */
  operation?: CardOperation;
  /** SUPERSEDE: заменить body целиком (frontmatter всё равно сливается). */
  replaceBody?: boolean;
  /** Содержимое существующего файла (undefined — карточки ещё нет). */
  existing?: string;
}

/**
 * Единственный источник вывода операции: явная operation, иначе легаси-автодетект.
 * Вызывающий обязан передавать в mergeCard сырую operation — по её отсутствию
 * отличается легаси-путь replace_body, где ## History приходит внутри body.
 */
export function resolveOperation(input: OperationInput): CardOperation {
  if (input.operation) return input.operation;
  if (input.replaceBody) return "SUPERSEDE";
  return input.existing === undefined ? "ADD" : "UPDATE";
}

/**
 * Легаси-путь, где вытесненная истина приходит секцией `## History` внутри body:
 * только вызов БЕЗ operation с replace_body. У явного SUPERSEDE его нет - там
 * вытесненный факт передаётся через historyEntry. Тул и стор обязаны решать это
 * одинаково, иначе один пускает вызов, а второй роняет его английским исключением.
 */
export function isLegacyHistoryReplace(
  operation: CardOperation | undefined,
  replaceBody: boolean | undefined,
  body: string,
): boolean {
  return (
    operation === undefined &&
    replaceBody === true &&
    hasH2Section(body.trim(), "History")
  );
}

export interface MergeInput extends OperationInput {
  title: string;
  fields: FmFields; // поля, которые тул реально знает и обновляет
  /** Поля только для новой карточки (created/source) — при merge не трогаются. */
  initialFields?: FmFields;
  body: string;
  related?: string[];
  /** Дата для маркера дописанного блока. */
  date: string;
  /** One dated fact moved out of Compiled Truth during SUPERSEDE. */
  historyEntry?: string;
}

export interface MergeResult {
  content: string;
  action: "created" | "updated" | "merged" | "replaced" | "noop";
  /** Model noise discarded because a new card has no displaced truth. */
  ignoredHistoryEntry?: true;
  /** Алиасы, которым не хватило места в потолке: ответ инструмента их называет. */
  droppedAliases?: string[];
}

/** Списковое поле фронтматтера как массив: блочный список, flow-список и легаси-строка
 * «через запятую» — один вид. Не список — пусто. */
function listField(value: FmValue | undefined): string[] {
  if (Array.isArray(value))
    return value.filter(Boolean).map((item) => String(item));
  if (typeof value !== "string") return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Слияние спискового поля: лежащие значения не теряются, дубли не копятся. Вход не
 * список — поле не наше, не трогаем (undefined). */
function unionList(
  previous: FmValue | undefined,
  next: FmValue | undefined,
): string[] | undefined {
  if (!Array.isArray(next)) return undefined;
  return [...new Set([...listField(previous), ...next.map(String)])];
}

// Потолок алиасов живёт в сторе: слияние — единственный путь, которым поле растёт, а
// колонка meta весит как title и десяток написаний на карточку размывает выдачу соседям.
export const ALIASES_MAX = 8;

/** Ключ «то же написание»: регистр и схлопнутые пробелы написания не различают, поэтому один
 * ключ и внутри вызова, и при слиянии с лежащими. ё/е здесь НЕ складываются: индекс FTS5 их
 * различает, и схлопнутое второе написание пропадало бы из поиска вместе со своим ключом
 * («Планерка» — то, как это пишут, — не находилась вовсе). */
export function aliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** Алиасы, которым не хватит места: тот же ключ и тот же потолок, что у слияния. Нужен
 * вызывающему, который решает про запись до слияния: NOOP в write_card ничего не пишет, но
 * обязан назвать написание, которого владелец в карточке не найдёт. */
export function droppedAliases(
  previous: FmValue | undefined,
  next: readonly string[],
): string[] {
  return mergeAliases(previous, [...next]).dropped;
}

/** Слияние алиасов: лежащие написания не выбрасываются никогда (карточка с одиннадцатью
 * алиасами от нашего вызова не худеет), новые добираются до потолка, а остальные
 * возвращаются вызывающему: он обязан их назвать. */
function mergeAliases(
  previous: FmValue | undefined,
  next: FmValue,
): { aliases: string[]; dropped: string[] } {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of listField(previous)) {
    const name = value.trim();
    const key = aliasKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(name);
  }
  const dropped: string[] = [];
  for (const value of listField(next)) {
    const name = value.trim();
    const key = aliasKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (aliases.length >= ALIASES_MAX) dropped.push(name);
    else aliases.push(name);
  }
  return { aliases, dropped };
}

export function mergeCard(input: MergeInput): MergeResult {
  const trimmedBody = input.body.trim();
  const operation = resolveOperation(input);

  assertRelatedSectionAbsent(trimmedBody);
  assertRequestShape(input, operation);
  assertBodyShape(trimmedBody, operation, input.date);
  if (operation === "NOOP") return noopResult(input);
  assertCardAvailability(operation, input.existing);
  assertSupersedeSource(input, operation, trimmedBody);

  const existing = input.existing;
  if (existing === undefined) return createCard(input, trimmedBody);

  const parsed = parseFrontmatter(existing);
  const oldBody = parsed.body;
  assertStoredBody(oldBody, operation);
  const { droppedAliases, fields: updates } = mergedFields(
    parsed,
    input.fields,
    input.date,
  );
  const assembled = assembleBody({
    date: input.date,
    // Повтор уже лежащей записи идёт тем же путём, что и любой другой дубль — см.
    // archivedHistoryEntry; дата принадлежит первой записи о факте, а не этому вызову.
    historyEntry: archivedHistoryEntry(input.historyEntry, oldBody, operation),
    nextDescription: updates.description,
    oldBody,
    operation,
    previousDescription: parsed.fields?.description,
    related: input.related,
    title: input.title,
    trimmedBody,
  });
  const render = (stamp: string) =>
    renderCard(updates, parsed, assembled.newBody, stamp);
  const content = render(input.date);
  // Строка про вытесняемый факт уже лежит в History — второй такой не пишем. Если при этом
  // карточка не меняется, это реплей уже выполненного вызова: писать нечего. Если меняется,
  // законность вызова решает одно: назван ли факт, который карточка держит СЕЙЧАС. Прежнее
  // значение того же факта уезжает в History прошлым UPDATE (смена description), поэтому
  // «строка уже есть» — не отставшая доставка, а её след; а доставка старого факта нынешнюю
  // истину не называет и отказывает так же, как на main.
  if (assembled.suppressedHistoryEntry) {
    if (isReplay(content, existing, parsed, render))
      return {
        content: existing,
        action: "noop",
        ...(droppedAliases.length ? { droppedAliases } : {}),
      };
    if (!displacedFactNames(operation, input.historyEntry, oldBody))
      throw new Error(
        "historyEntry already appears in ## History but this SUPERSEDE still changes the card; " +
          "send the fact this call displaces",
      );
  }
  assertDisplacedFactNamed(operation, input.historyEntry, oldBody);
  return {
    content,
    action: cardAction(operation, assembled.appended),
    ...(droppedAliases.length ? { droppedAliases } : {}),
  };
}

// ─── шаги mergeCard ────────────────────────────────────────────────────────
// Разрезано по решениям, которые принимает один вызов: форма запроса, форма тела,
// состояние карточки на диске, сборка тела и сверка с лежащим файлом. Порядок вызовов в
// mergeCard - это порядок, в котором отказы видел вызывающий, и он не меняется.

/** ## Related сочиняет write_card из related: тело с этим заголовком значит, что модель
 * ведёт секцию сама, и в карточке появляется вторая. */
function assertRelatedSectionAbsent(trimmedBody: string): void {
  if (h2Sections(trimmedBody.split("\n"), "Related").length)
    throw new Error(
      "body must not contain ## Related; pass links through related",
    );
}

/** Сочетания полей, которые не значат ничего: replace_body без SUPERSEDE и history_entry
 * там, где вытеснять нечего или нельзя (UPDATE/NOOP подделывал бы ## History). */
function assertRequestShape(input: MergeInput, operation: CardOperation): void {
  if (input.replaceBody && operation !== "SUPERSEDE")
    throw new Error("replaceBody is valid only for SUPERSEDE");
  if (
    input.historyEntry !== undefined &&
    operation !== "ADD" &&
    operation !== "SUPERSEDE"
  )
    throw new Error("historyEntry is valid only for SUPERSEDE");
  if (operation === "SUPERSEDE" && input.historyEntry !== undefined)
    assertHistoryEntryShape(input.historyEntry);
}

function assertHistoryEntryShape(historyEntry: string): void {
  if (/[\r\n]/.test(historyEntry))
    throw new Error("historyEntry must be a single line");
  if (historyEntry.trim().length > HISTORY_ENTRY_CAP)
    throw new Error(
      `historyEntry must not exceed ${HISTORY_ENTRY_CAP} characters`,
    );
}

/** Незакрытый фенс делает кодом всё до конца тела, и проверка заголовков ниже перестаёт
 * видеть ## History/## Log за ним. Искать заголовки внутри открытого фенса нечем - такое
 * тело отклоняется целиком, включая легаси-путь replace_body: он единственный, через
 * который открытый фенс попадал в карточку и ломал её следующий SUPERSEDE. NOOP тела не
 * пишет вовсе, поэтому его фенс никого не касается. Секции карточки принадлежат
 * write_card: H1 - заголовку, ## History/## Log - append-only секциям. Тело, которое
 * сочинила модель, несёт факт и только факт, иначе выдуманная History въезжает в карточку
 * соседним полем и вычистить её уже нечем. */
function assertBodyShape(
  trimmedBody: string,
  operation: CardOperation,
  date: string,
): void {
  if (operation !== "NOOP" && hasUnclosedFence(trimmedBody))
    throw new Error(`${operation} body must close every code fence`);
  if (
    (operation === "ADD" || operation === "UPDATE") &&
    hasOutsideHeading(trimmedBody, /^ {0,3}#{1,2}\s+/)
  )
    throw new Error(`${operation} body must be a fact without H1/H2 headings`);
  if (operation === "UPDATE") assertLogEntryShape(trimmedBody, date);
}

/** Проверки выше судят сырое тело, а UPDATE кладёт его в карточку сдвинутым на два пробела
 * под буллет Log. Фенс с отступом 2-3 после сдвига уезжает на 4-5 и фенсом быть
 * перестаёт: его содержимое выходит наружу, и спрятанный внутри ## History становится
 * настоящим заголовком append-only секции History. Поэтому запись судим в том виде, в
 * каком она ляжет в карточку. */
function assertLogEntryShape(trimmedBody: string, date: string): void {
  const entry = logEntryLines(trimmedBody, date);
  const scanned = scanFences(entry);
  if (
    scanned.open ||
    entry.some(
      (line, index) => scanned.outside[index] && /^ {0,3}#{1,2}\s+/.test(line),
    )
  )
    throw new Error(
      "UPDATE body must start every code fence at the line start; a Log entry indents the body by two spaces",
    );
}

function noopResult(input: MergeInput): MergeResult {
  if (input.existing === undefined)
    throw new Error("NOOP requires an existing card");
  // Лишние алиасы считаются и здесь: `noop` без этой оговорки читается как «написание
  // записано», а в карточке его нет.
  const next = input.fields.aliases;
  const dropped = Array.isArray(next)
    ? droppedAliases(parseFrontmatter(input.existing).fields?.aliases, next)
    : [];
  return {
    content: input.existing,
    action: "noop",
    ...(dropped.length ? { droppedAliases: dropped } : {}),
  };
}

/** ADD не перезаписывает карточку, UPDATE и SUPERSEDE не заводят её заново. */
function assertCardAvailability(
  operation: CardOperation,
  existing: string | undefined,
): void {
  if (operation === "ADD" && existing !== undefined)
    throw new Error("ADD refuses to overwrite an existing card");
  if (
    (operation === "UPDATE" || operation === "SUPERSEDE") &&
    existing === undefined
  )
    throw new Error(`${operation} requires an existing card`);
}

/** SUPERSEDE обязан назвать вытесняемый факт - либо history_entry, либо (в легаси-пути
 * replace_body без operation) секцией ## History в теле. Тело SUPERSEDE переписывает
 * Compiled Truth, поэтому свои H2 ему разрешены, а H1 и структурные секции - нет: иначе
 * модель дописывает в append-only ## History строки с произвольными датами, и вычистить их
 * уже нечем. Легаси-путь не трогаем - там ## History и есть способ передать вытесненный
 * факт. */
function assertSupersedeSource(
  input: MergeInput,
  operation: CardOperation,
  trimmedBody: string,
): void {
  if (operation !== "SUPERSEDE") return;
  if (
    !input.historyEntry?.trim() &&
    !isLegacyHistoryReplace(input.operation, input.replaceBody, trimmedBody)
  )
    throw new Error(
      "SUPERSEDE requires historyEntry or a legacy ## History section",
    );
  if (
    input.operation !== undefined &&
    hasOutsideHeading(trimmedBody, /^ {0,3}(?:#\s+|##\s+(?:History|Log)\s*$)/i)
  )
    throw new Error(
      "SUPERSEDE body must be a fact without an H1 or a ## History/## Log heading",
    );
}

/** Новая карточка: frontmatter целиком (fields + initialFields единственный раз), H1, тело. */
function createCard(input: MergeInput, trimmedBody: string): MergeResult {
  const all: FmFields = { ...input.fields, ...(input.initialFields || {}) };
  const fm = ["---", writeFrontmatter(all, []), "---", ""].join("\n");
  let out = `${fm}\n# ${input.title}\n\n${trimmedBody}\n`;
  if (input.related && input.related.length)
    out = mergeRelated(out, input.related);
  return {
    content: out,
    action: "created",
    ...(input.historyEntry !== undefined
      ? { ignoredHistoryEntry: true as const }
      : {}),
  };
}

/** Тот же принцип со стороны диска: открытый фенс в лежащей карточке уводит её
 * ## History и ## Log в код, границ секций нет - SUPERSEDE молча снёс бы всю
 * append-only History, а UPDATE не нашёл бы Log и дописал бы факт внутрь кода, откуда
 * его уже не видно. Отказ для обеих операций; фенс в карточке чинит человек. */
function assertStoredBody(oldBody: string, operation: CardOperation): void {
  if (
    (operation === "SUPERSEDE" || operation === "UPDATE") &&
    hasUnclosedFence(oldBody)
  ) {
    throw new Error(
      `existing card body leaves a code fence open; close it before ${operation}`,
    );
  }
  if (
    operation === "UPDATE" &&
    hasOutsideHeading(
      oldBody,
      /^ {0,3}##\s+(?:Обновление|Update)\s+\d{4}-\d{2}-\d{2}\s*$/i,
    )
  ) {
    throw new Error(
      "existing card has legacy dated update headings; run semantic cleanup before UPDATE",
    );
  }
}

/** Обновляем ТОЛЬКО известные ключи; created/source и любые неизвестные поля
 * (tier, relevance, last_accessed, phone, telegram, priority…) остаются как были. */
function mergedFields(
  parsed: ReturnType<typeof parseFrontmatter>,
  fields: FmFields,
  date: string,
): { fields: FmFields; droppedAliases: string[] } {
  const updates: FmFields = { ...fields };
  const droppedAliases: string[] = [];
  delete updates.created;
  if (parsed.fields?.source) delete updates.source;
  if (parsed.fields) {
    const tags = unionList(parsed.fields.tags, updates.tags);
    if (tags) updates.tags = tags;
    // Алиасы — единственный носитель связи «Пепси = Pepsi»: FTS не транслитерирует,
    // не чинит опечатки и не ловит падеж, а слияние не теряет лежащие написания.
    if (Array.isArray(updates.aliases)) {
      const merged = mergeAliases(parsed.fields.aliases, updates.aliases);
      updates.aliases = merged.aliases;
      droppedAliases.push(...merged.dropped);
    }
  }
  updates.updated = date;
  return { droppedAliases, fields: updates };
}

interface AssemblyInput {
  oldBody: string;
  operation: CardOperation;
  trimmedBody: string;
  historyEntry?: string;
  date: string;
  title: string;
  related?: string[];
  /** Прежнее и нынешнее значение frontmatter-половины Compiled Truth. */
  previousDescription?: FmValue;
  nextDescription?: FmValue;
}

interface BodyAssembly {
  newBody: string;
  appended: boolean;
  /** То же самое уже лежит в ## History, поэтому строка НЕ дописана. */
  suppressedHistoryEntry: boolean;
}

/** Тело карточки после записи: вытеснение истины или факт в Log, заголовок, Related и
 * след прежнего описания - в том порядке, в каком карточка хранится. */
function assembleBody(input: AssemblyInput): BodyAssembly {
  let newBody =
    input.operation === "UPDATE"
      ? collapseLogSections(input.oldBody)
      : input.oldBody;
  let appended = false;
  // A confirmed-cancel rollup retry can replay the exact completed tool call: the same
  // canonical entry is already archived, so the truth behind it is displaced already and
  // the entry is not written twice. Anything else that ends here is not a replay - see the
  // fail-closed gate below, which keeps a stale delivery from rolling the card back.
  let suppressedHistoryEntry = false;
  if (input.operation === "SUPERSEDE") {
    const replaced = replaceCompiledTruth(
      input.oldBody,
      input.trimmedBody,
      input.historyEntry,
      input.date,
    );
    suppressedHistoryEntry = replaced.suppressedAgainstArchive;
    newBody = `\n${replaced.body.trim()}\n`;
  } else if (!bodyContains(input.oldBody, input.trimmedBody)) {
    newBody = appendLog(newBody, input.trimmedBody, input.date);
    appended = true;
  }
  if (!extractH1(newBody))
    newBody = `# ${input.title}\n\n${newBody.replace(/^\s+/, "")}`;
  const beforeRelated = newBody;
  newBody = mergeRelated(newBody, input.related ?? []);
  if (beforeRelated !== newBody) appended = true;
  // Прежнее описание не выбрасывается: перед записью нового значения Compiled Truth
  // старое уезжает в ## History датированной строкой. Ночной rollup передаёт description
  // на КАЖДОМ UPDATE и без нужды его не переписывает, поэтому вытеснением считается
  // только реальная смена значения — см. displacedDescription.
  newBody = archiveDisplacedDescription(
    newBody,
    input.previousDescription,
    input.nextDescription,
    input.date,
  );
  return { newBody, appended, suppressedHistoryEntry };
}

/** Итоговый файл: пересобранный frontmatter и тело. Дату подставляет вызывающий - реплей,
 * перешагнувший полночь, отличается от лежащей карточки ровно ею. */
function renderCard(
  updates: FmFields,
  parsed: ReturnType<typeof parseFrontmatter>,
  body: string,
  stamp: string,
): string {
  return `---\n${writeFrontmatter(
    { ...updates, updated: stamp },
    parsed.fields ? parsed.lines : [],
  )}\n---\n${body.replace(/\s*$/, "")}\n`;
}

/** Реплей, перешагнувший полночь, отличается от лежащей карточки только сегодняшним
 * `updated:`. Записать файл ради одной этой строки - выдать за изменение то, что
 * изменением не является, поэтому дату исключаем из сверки. */
function isReplay(
  content: string,
  existing: string,
  parsed: ReturnType<typeof parseFrontmatter>,
  render: (stamp: string) => string,
): boolean {
  const previousStamp = parsed.fields?.updated;
  return (
    content === existing ||
    (typeof previousStamp === "string" && render(previousStamp) === existing)
  );
}

/** Вызов реально меняет карточку - и вытесняемый факт обязан быть про НЫНЕШНЮЮ истину.
 * Расхождение с History ловит лишь буквальный повтор строки: тот же древний факт под
 * другой датой проходил бы её насквозь, уложив в History свой дубль, а нынешнюю истину
 * стерев молча. Хвост истины (пример в фенсе, уточнение следующим абзацем) повторять не
 * обязательно - началом строка совпасть обязана. */
/** Называет ли historyEntry факт, который карточка держит сейчас (хвост истины повторять не
 * обязательно — началом строка совпасть обязана). */
function displacedFactNames(
  operation: CardOperation,
  historyEntry: string | undefined,
  oldBody: string,
): boolean {
  if (operation !== "SUPERSEDE" || !historyEntry?.trim()) return false;
  const displaced = displacedFact(historyEntry);
  const truth = comparableFact(compiledTruth(oldBody));
  return Boolean(displaced && truth && truth.startsWith(displaced));
}

function assertDisplacedFactNamed(
  operation: CardOperation,
  historyEntry: string | undefined,
  oldBody: string,
): void {
  if (operation !== "SUPERSEDE" || !historyEntry?.trim()) return;
  if (!displacedFactNames(operation, historyEntry, oldBody))
    throw new Error(
      "historyEntry must state the Compiled Truth this SUPERSEDE displaces; " +
        "send the fact the card holds now",
    );
}

function cardAction(
  operation: CardOperation,
  appended: boolean,
): MergeResult["action"] {
  if (operation === "SUPERSEDE") return "replaced";
  return appended ? "merged" : "updated";
}

// ─── lock + атомарная запись ───────────────────────────────────────────────

const LOCK_STALE_MS = 15_000;

/** Лок карточки — каталог `<карточка>.lock` рядом с ней. Занятая карточка это внятная
 * ошибка для модели, а не тихая перезапись чужой правки. Ждём, отпуская event loop: под
 * этим локом идёт ещё и коммит правки, а синхронное ожидание заморозило бы его. */
export async function acquireLock(
  file: string,
  timeoutMs = 5000,
): Promise<() => void> {
  const lock = `${file}.lock`;
  const held = await acquireFileLock(lock, {
    timeoutMs,
    staleMs: LOCK_STALE_MS,
  });
  if (held === null)
    throw new Error(`Карточка занята другим процессом: ${lock}`);
  return () => {
    releaseFileLock(held);
  };
}

/** Запись через временный файл + rename: читатель никогда не видит половину карточки. */
export function atomicWrite(file: string, content: string): void {
  writeFileAtomicSync(file, content);
}
