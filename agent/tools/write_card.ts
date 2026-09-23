import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  acquireLock,
  aliasKey,
  ALIASES_MAX,
  atomicWrite,
  droppedAliases,
  isLegacyHistoryReplace,
  mergeCard,
  resolveCard,
  resolveOperation,
  type CardOperation,
  type Identity,
} from "../lib/card-store.js";
import { parseFrontmatterOrSkip } from "../lib/frontmatter.js";
import { resolveTimeZone } from "../lib/timezone.js";
import { resolveVaultDir } from "@iva/vault-dir";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import { commitVaultWrite } from "../lib/vault-commit.ts";
import {
  brokenLinksError,
  relatedTarget,
  unresolvedLinkTargets,
  wikilinkTargets,
} from "../lib/vault-links.ts";

// Строго типизированная запись карточки памяти. Заменяет «write_file по наитию» для карточек:
// zod-enum на type/status берётся из autograph schema.json (единый источник правды), поэтому
// модель НЕ может выдумать тип или добавить неизвестное поле — вызов упадёт на валидации.
// Ночной enforce.py остаётся backstop'ом для всего, что записалось мимо этого тула.

// Типы карточек, которые модель создаёт интерактивно (summary-типы пишет ночной rollup, не тул).
const CARD_TYPE_DIR: Record<string, string> = {
  contact: "contacts",
  project: "projects",
  decision: "decisions",
  idea: "ideas",
  note: "notes",
};
const DESC_CAP = 500;
// Другие написания имени — не второй заголовок, а мостик к нему: искать по ним должно
// хватать, но колонка meta весит как title, и десяток алиасов на карточку размывает
// выдачу соседям. Потолок числа держит и слияние с лежащими (card-store), здесь — только
// форма записи.
const ALIAS_CAP = 80;

// Статус уже лежащей карточки. Её frontmatter мог сломать владелец руками, и до
// обёртки такая карточка вылетала исключением из тула: "посмотри карточку"
// превращалось в ошибку хода. Нечитаемый frontmatter = статуса нет, берём запасной.
function storedStatus(content: string, path: string, fallback: string): string {
  const value = parseFrontmatterOrSkip(content, path)?.fields?.status;
  return typeof value === "string" ? value : fallback;
}

// Границы входа: пробельная пустота даёт карточку без имени/описания, а перевод строки в
// однострочном поле уезжает в frontmatter или в разметку и превращается в новую секцию.
// Оба случая отклоняются на входе, а не «чинятся» молча; нормализация — в execute.
const nonBlank = (label: string) =>
  z
    .string()
    .refine((v) => v.trim().length > 0, `${label} не должен быть пустым`);

const singleLine = (label: string) =>
  nonBlank(label).refine(
    (v) => !/[\r\n]/.test(v),
    `${label} должен быть одной строкой`,
  );

/** lowercase-kebab + дедуп ПОСЛЕ нормализации: «Foo Bar» и « foo-bar » — один тег. */
const normalizeTags = (tags: string[]): string[] => [
  ...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))),
];

/**
 * Другое написание того же имени. Регистр, ё/е и схлопнутые пробелы написания не различают,
 * поэтому дедуп идёт по общему с карточной слиянием ключу, а в карточке остаётся первое
 * написание как есть.
 */
const normalizeAliases = (aliases: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const value = alias.trim();
    const key = aliasKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
};

/**
 * След отброшенного входа: только имена полей, без содержимого карточки — журнал не место
 * для текста, который модель могла нафантазировать. Сбой sink'а (закрытый stderr, EPIPE)
 * гасится: карточка уже записана, и журнал не имеет права превратить успех в отказ.
 */
function logIgnoredHistoryEntry(): void {
  try {
    console.warn(
      JSON.stringify({
        event: "write_card_input_normalized",
        // Вытеснять нечего только у новой карточки, а её создаёт лишь ADD.
        operation: "ADD",
        ignored_field: "history_entry",
      }),
    );
  } catch {
    /* журнал недоступен — на записанную карточку это не влияет */
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
}

// Схема vault'а: корень vault'а → легаси `.claude`-путь (vault'ы до 0.3.3) → дефолт из репо.
function schemaPath(): string {
  const candidates = [
    join(resolveVaultDir(process.cwd()), "schema.json"),
    join(
      resolveVaultDir(process.cwd()),
      ".claude",
      "skills",
      "autograph",
      "schema.json",
    ),
    join("scripts", "autograph", "schema.example.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

// Читаем схему на старте: валидные статусы per-type + алиасы. Fallback — зашитый минимум,
// чтобы тул не падал, если vault ещё не инициализирован.
function loadSchema(): {
  status: Record<string, string[]>;
  aliases: Record<string, string>;
} {
  const fallback: {
    status: Record<string, string[]>;
    aliases: Record<string, string>;
  } = {
    status: {
      contact: ["active", "inactive"],
      project: ["active", "done", "paused", "cancelled", "draft"],
      decision: ["active", "superseded", "reverted"],
      idea: ["active", "explored", "archived", "draft"],
      note: ["active", "draft", "archived"],
    },
    aliases: {
      person: "contact",
      company: "contact",
      thought: "note",
      proposal: "idea",
    },
  };
  try {
    const raw = readFileSync(schemaPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    const nodeTypes = isRecord(parsed.node_types)
      ? parsed.node_types
      : undefined;
    const status: Record<string, string[]> = {};
    for (const t of Object.keys(CARD_TYPE_DIR)) {
      const node = nodeTypes?.[t];
      const configured = isRecord(node)
        ? isStringArray(node.status)
          ? node.status
          : isStringArray(node.statuses)
            ? node.statuses
            : undefined
        : undefined;
      status[t] = configured ?? fallback.status[t] ?? ["active"];
    }
    return {
      status,
      aliases: asStringRecord(parsed.type_aliases) ?? fallback.aliases,
    };
  } catch {
    return fallback;
  }
}

const SCHEMA = loadSchema();
const CARD_TYPES = Object.keys(CARD_TYPE_DIR) as [string, ...string[]];

// Алиасы типов из схемы применяются ДО валидации: описание поля обещает person/company →
// contact, значит z.enum не должен отклонять их раньше execute. Алиасы, ведущие в типы вне
// CARD_TYPE_DIR (daily → daily-summary), не разворачиваются — их пишет ночной rollup.
function normalizeType(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase();
  if (k in CARD_TYPE_DIR) return k;
  const mapped = SCHEMA.aliases[k];
  return mapped && mapped in CARD_TYPE_DIR ? mapped : k;
}

// Транслитерация не нужна — vault хранит кириллические слаги нормально (см. существующие карточки).
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Результат тула: отказ с внятным текстом или записанная карточка. Один тип на все
// ветки, чтобы execute оставался последовательностью решённых вопросов.
type CardOutcome =
  | { ok: false; error: string; candidates?: string[] }
  | {
      ok: true;
      action: string;
      file: string;
      matchedBy: string;
      /** Что записалось не целиком: имена полей и значений, без содержимого карточки. */
      note?: string;
      status: string;
      type: string;
    };

/** Всё, что вызов принёс в запись: разложено один раз в execute, чтобы шаги ниже брали
 * готовое и не пересчитывали его по-своему. */
interface CardWrite {
  allowed: string[];
  aliases: string[];
  body: string;
  confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" | undefined;
  description: string;
  domain: string | undefined;
  /** Файл карточки на диске (абсолютный путь). */
  file: string;
  /** Отжатый history_entry: пробельная пустота равна отсутствующему полю. */
  historyEntry: string | undefined;
  /** Сырое поле схемы: ADD отбрасывает его сам и фиксирует это в журнале. */
  history_entry: string | undefined;
  id: Identity;
  operation: CardOperation | undefined;
  related: string[] | undefined;
  /** Путь карточки относительно vault'а — то, что видит модель. */
  rel: string;
  /** Тот же vault: коммит называет корень, а не угадывает его. */
  root: string;
  replace_body: boolean | undefined;
  status: string | undefined;
  tags: string[];
  title: string;
  type: string;
}

/** Статус валидируется по схеме типа жёстко — иначе модель придумает статус, которого
 * у типа нет. */
function statusError(
  type: string,
  status: string | undefined,
  allowed: string[],
): string | null {
  if (status && !allowed.includes(status)) {
    return `Недопустимый status "${status}" для type "${type}". Разрешены: ${allowed.join(", ")}.`;
  }
  return null;
}

interface CardTarget {
  dir: string;
  file: string;
  id: Identity;
  rel: string;
  /** Vault, в котором лежит карточка: он же корень её репозитория. */
  root: string;
}

/** Каталог типа и файл карточки: точный слаг или та же сущность по H1/name/aliases
 * (легаси-файлы с латинским слагом и кириллическим заголовком). Несколько кандидатов —
 * писать нельзя, нужен выбор человека/модели. */
function resolveTarget(
  type: string,
  title: string,
): CardTarget | { error: string; candidates: string[] } {
  const root = resolveVaultDir(process.cwd());
  const dir = join(root, "cards", CARD_TYPE_DIR[type]);
  const id = resolveCard(dir, title);
  const candidates = (id.candidates ?? []).map((f) =>
    relative(root, f).split(sep).join("/"),
  );
  if (candidates.length > 1) {
    return {
      candidates,
      error:
        `Неоднозначная карточка для "${title}": подходят ${candidates.length} файлов. ` +
        "Уточни заголовок или обнови нужный файл явно — ничего не записано.",
    };
  }
  const file = id.file;
  return {
    dir,
    file,
    id,
    rel: relative(root, file).split(sep).join("/"),
    root,
  };
}

/** Стирание чужой карточки: replace_body называет новое тело вместо старого и потому
 * применим только к SUPERSEDE. */
function replaceBodyRefusal(card: CardWrite): CardOutcome | null {
  if (!card.replace_body) return null;
  if (card.operation === undefined || card.operation === "SUPERSEDE")
    return null;
  return { ok: false, error: "replace_body допустим только для SUPERSEDE." };
}

/** NOOP ничего не пишет: он принимает только существующую карточку и не принимает полей,
 * которыми её правят. */
function noopRefusal(card: CardWrite): CardOutcome | null {
  if (card.replace_body || card.historyEntry !== undefined) {
    return {
      ok: false,
      error: "NOOP не принимает replace_body или history_entry.",
    };
  }
  if (existsSync(card.file)) return null;
  return {
    ok: false,
    error: `NOOP требует существующую карточку ${card.rel}.`,
  };
}

/** Запросы, которые тул решает до лока и без чтения карточки: NOOP ничего не пишет (и
 * отказывает, когда его просят заодно стереть карточку чужим полем), replace_body
 * применим только к SUPERSEDE. null — запрос надо писать. */
function earlyOutcome(card: CardWrite): CardOutcome | null {
  const noop = card.operation === "NOOP";
  const refusal = noop ? noopRefusal(card) : replaceBodyRefusal(card);
  if (refusal !== null) return refusal;
  if (!noop) return null;
  const existing = readFileSync(card.file, "utf8");
  // Написание, которому не хватит места, называется и здесь: `noop` без этого читается как
  // «записал», а в карточке его нет.
  const dropped = droppedAliases(
    parseFrontmatterOrSkip(existing, card.rel)?.fields?.aliases,
    card.aliases,
  );
  return {
    action: "noop",
    file: card.rel,
    matchedBy: card.id.matchedBy,
    ...(dropped.length ? { note: droppedAliasesNote(dropped) } : {}),
    ok: true,
    status: storedStatus(existing, card.rel, card.status ?? card.allowed[0]),
    type: card.type,
  };
}

/** Лок вокруг карточки: занятую карточку модель должна увидеть как внятную ошибку, а не
 * как тихую перезапись чужой правки, а сбой записи — как «не записалось», а не как
 * уроненный ход. Освобождение лока — в finally: его требует даже выброшенный сбой. */
async function withCardLock(
  file: string,
  rel: string,
  write: () => Promise<CardOutcome>,
): Promise<CardOutcome> {
  let release: (() => void) | null = null;
  try {
    release = await acquireLock(file);
    return await write();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Не удалось записать карточку ${rel}: ${detail}`,
    };
  } finally {
    release?.();
  }
}

/** history_entry там, где вытеснять нельзя или нечего (UPDATE подделывал бы ## History,
 * у ADD вытесненной истины ещё нет), и карточка, которой нет. */
function requestStateError(
  effectiveOperation: CardOperation,
  request: CardWrite & { existing?: string },
): { ok: false; error: string } | null {
  if (request.historyEntry !== undefined && effectiveOperation === "UPDATE") {
    return { ok: false, error: "history_entry допустим только для SUPERSEDE." };
  }
  if (effectiveOperation === "ADD" && request.existing !== undefined) {
    return {
      ok: false,
      error: `ADD отказан: карточка ${request.rel} уже существует.`,
    };
  }
  if (effectiveOperation !== "ADD" && request.existing === undefined) {
    return {
      ok: false,
      error: `${effectiveOperation} требует существующую карточку ${request.rel}.`,
    };
  }
  return null;
}

/** SUPERSEDE обязан принести вытесненный факт - либо полем, либо (в легаси-пути
 * replace_body без operation) секцией ## History в теле. */
function supersedeSourceError(
  effectiveOperation: CardOperation,
  request: CardWrite,
): { ok: false; error: string } | null {
  if (
    effectiveOperation === "SUPERSEDE" &&
    !request.history_entry?.trim() &&
    !isLegacyHistoryReplace(
      request.operation,
      request.replace_body === true,
      request.body,
    )
  ) {
    return {
      ok: false,
      error:
        "SUPERSEDE требует history_entry; legacy replace_body должен содержать ## History.",
    };
  }
  return null;
}

/** Отказы, которые не зависят от содержимого карточки. */
function requestError(
  effectiveOperation: CardOperation,
  request: CardWrite & { existing?: string },
): { ok: false; error: string } | null {
  return (
    requestStateError(effectiveOperation, request) ??
    supersedeSourceError(effectiveOperation, request)
  );
}

/** Запрос тула в том виде, в каком с ним работают шаги: обрезанные поля, отжатый
 * history_entry, разрешённые статусы типа. */
function cardWrite(
  input: {
    aliases?: string[];
    body: string;
    confidence?: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
    description: string;
    domain?: string;
    history_entry?: string;
    operation?: CardOperation;
    related?: string[];
    replace_body?: boolean;
    status?: string;
    tags: string[];
    title: string;
    type: string;
  },
  target: CardTarget,
  allowed: string[],
): CardWrite {
  return {
    allowed,
    aliases: normalizeAliases(input.aliases ?? []),
    body: input.body,
    confidence: input.confidence,
    description: input.description.trim(),
    domain: input.domain?.trim(),
    file: target.file,
    root: target.root,
    // Пробельная пустота history_entry (value.trim() === "") ничего не вытесняет и не
    // подделывает History: для UPDATE и NOOP она равна отсутствующему полю — так же, как
    // SUPERSEDE читает его через trim(). Модели, заполняющие все поля схемы, шлют "" и
    // без этого зацикливаются на одном отказе.
    historyEntry: input.history_entry?.trim() ? input.history_entry : undefined,
    history_entry: input.history_entry,
    id: target.id,
    operation: input.operation,
    related: input.related,
    rel: target.rel,
    replace_body: input.replace_body,
    status: input.status?.trim(),
    tags: normalizeTags(input.tags),
    title: input.title.trim(),
    type: input.type,
  };
}

/** Поля, которые тул реально знает: на ADD к ним добавляется стартовый статус и
 * confidence, на UPDATE — только названные явно, иначе лежащее значение сотрётся. */
function cardFields(
  card: CardWrite,
  effectiveOperation: CardOperation,
): {
  type: string;
  description: string;
  tags: string[];
  aliases?: string[];
  status?: string;
  confidence?: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  domain?: string;
} {
  return {
    type: card.type,
    description: card.description,
    tags: card.tags,
    ...(card.aliases.length ? { aliases: card.aliases } : {}),
    ...(effectiveOperation === "ADD"
      ? {
          status: card.status ?? card.allowed[0],
          confidence: card.confidence ?? "EXTRACTED",
        }
      : {
          ...(card.status !== undefined ? { status: card.status } : {}),
          ...(card.confidence !== undefined
            ? { confidence: card.confidence }
            : {}),
        }),
    ...(card.domain ? { domain: card.domain } : {}),
  };
}

/** Алиасы сверх потолка остаются в ответе инструмента: они не записаны, но и не пропали
 * молча — вызов не роняем, ночь от этого падать не должна. */
function droppedAliasesNote(dropped: string[]): string {
  return `Алиасы не поместились (потолок ${ALIASES_MAX}): ${dropped.join(", ")}.`;
}

/** Слаг карточки для сообщения коммита: имя файла без каталога и расширения. */
function cardSlug(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/u, "");
}

/** Ссылка в никуда роняет health score графа, а ночной graph.fix её не чинит: резолвится
 * она ничем. Проверяется ВХОД (тело и related), а не слитая карточка: за старые битые
 * ссылки в ней отвечает не этот вызов. Зовётся перед записью, после структурных отказов:
 * их текст точнее, и он должен доходить первым. */
function brokenLinksRefusal(card: CardWrite): CardOutcome | null {
  const broken = unresolvedLinkTargets(
    [...wikilinkTargets(card.body), ...(card.related ?? []).map(relatedTarget)],
    { vaultDir: card.root, source: card.rel.replace(/\.md$/u, "") },
  );
  return broken.length ? { ok: false, error: brokenLinksError(broken) } : null;
}

/** Запись под локом: что лежит на диске, какая операция из этого следует, отказы по
 * состоянию, слияние, атомарная запись и коммит затронутого пути. Коммит идёт под тем же
 * локом: история памяти повторяет порядок правок карточки. */
async function writeLockedCard(card: CardWrite): Promise<CardOutcome> {
  const existing = existsSync(card.file)
    ? readFileSync(card.file, "utf8")
    : undefined;
  const effectiveOperation = resolveOperation({
    operation: card.operation,
    replaceBody: card.replace_body,
    existing,
  });
  const rejected = requestError(effectiveOperation, { ...card, existing });
  if (rejected !== null) return rejected;
  const { content, action, droppedAliases, ignoredHistoryEntry } = mergeCard({
    body: card.body,
    date: today(),
    existing,
    fields: cardFields(card, effectiveOperation),
    initialFields: { created: today(), source: `daily/${today()}.md` },
    // ADD получает сырое поле: пустую строку он отбрасывает сам и фиксирует это в журнале.
    historyEntry:
      effectiveOperation === "ADD" ? card.history_entry : card.historyEntry,
    // Сырая operation: по её отсутствию mergeCard узнаёт легаси-путь replace_body.
    operation: card.operation,
    related: card.related,
    replaceBody: card.replace_body === true,
    title: card.title,
  });
  const brokenLinks = brokenLinksRefusal(card);
  if (brokenLinks !== null) return brokenLinks;
  if (action !== "noop") {
    atomicWrite(card.file, content);
    await commitVaultWrite(
      `card ${cardSlug(card.rel)}: ${effectiveOperation}`,
      [card.file],
      card.root,
    );
  }
  if (ignoredHistoryEntry) logIgnoredHistoryEntry();
  return {
    action,
    file: card.rel,
    matchedBy: card.id.matchedBy,
    // Написанное мимо карточки модель обязана увидеть: молча пропавший алиас владелец не
    // найдёт поиском и не починит.
    ...(droppedAliases?.length
      ? { note: droppedAliasesNote(droppedAliases) }
      : {}),
    ok: true,
    status: storedStatus(content, card.rel, card.status ?? card.allowed[0]),
    type: card.type,
  };
}

export default defineTool({
  description:
    "Создать или обновить карточку памяти в vault; для карточек — ЭТО, не write_file. " +
    "Поля вне схемы недопустимы. Без operation операция — по карточке. " +
    "Summary (день/неделя/…) НЕ создавай — их пишет rollup.",
  inputSchema: z.object({
    operation: z
      .enum(["ADD", "UPDATE", "SUPERSEDE", "NOOP"])
      .optional()
      .describe(
        "ADD — новая; UPDATE — факт в ## Log; SUPERSEDE — замена истины; NOOP — ничего.",
      ),
    type: z
      .preprocess(normalizeType, z.enum(CARD_TYPES))
      .describe("Тип; алиасы person/company → contact"),
    title: singleLine("title").describe("Заголовок сущности"),
    description: singleLine("description")
      .max(
        DESC_CAP,
        `description слишком длинное: максимум ${DESC_CAP} символов; сократи его и повтори вызов`,
      )
      .describe("Выжимка что/зачем, 1–2 фразы"),
    tags: z
      .array(singleLine("tag"))
      .min(1)
      .max(6)
      .describe("2–5 тегов, lowercase-kebab"),
    aliases: z
      .array(
        singleLine("alias").max(
          ALIAS_CAP,
          `alias слишком длинный: максимум ${ALIAS_CAP} символов`,
        ),
      )
      .max(ALIASES_MAX, `Слишком много алиасов: максимум ${ALIASES_MAX}`)
      .optional()
      .describe(
        "Другие написания имени — латиница, транслит, разговорное, с опечаткой",
      ),
    status: singleLine("status").optional().describe("Валидируется по типу"),
    domain: singleLine("domain").optional().describe("Домен (work/personal/…)"),
    related: z
      .array(singleLine("related"))
      .optional()
      .describe("Связи [[…]]: пути/слаги"),
    body: nonBlank("body").describe(
      "Тело в markdown: только факты, без H1/H2 и ## History/Log/Related — их ведёт тул",
    ),
    history_entry: z
      .string()
      .optional()
      .describe(
        "ТОЛЬКО SUPERSEDE: строка в ## History, формат 'YYYY-MM-DD: факт' " +
          "(без даты — сегодня; пусто = нет поля). ADD отбрасывает, UPDATE/NOOP с текстом — ошибка.",
      ),
    confidence: z
      .enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"])
      .optional()
      .describe("EXTRACTED — прямо; INFERRED — вывод (default EXTRACTED)"),
    replace_body: z
      .boolean()
      .optional()
      .describe(
        "Легаси-путь без operation: body целиком, ## History — внутри body.",
      ),
  }),
  async execute(input) {
    try {
      const allowed = SCHEMA.status[input.type] || ["active"];
      // Валидация статуса против схемы типа (жёстко — иначе модель придумает статус).
      const badStatus = statusError(input.type, input.status?.trim(), allowed);
      if (badStatus !== null) return { ok: false, error: badStatus };

      // Идентичность: точный слаг → иначе карточка того же типа с таким же H1/name/aliases
      // (легаси-файлы с латинским слагом и кириллическим заголовком).
      const target = resolveTarget(input.type, input.title.trim());
      if ("error" in target) {
        return {
          candidates: target.candidates,
          error: target.error,
          ok: false,
        };
      }
      // Схема гарантирует непустоту и однострочность; обрезка — в cardWrite, чтобы в файл
      // не уехали краевые пробелы (они заставили бы квотировать скаляр и сломали бы
      // заголовок). related нормализует mergeRelated, body — mergeCard.
      const card = cardWrite(input, target, allowed);

      const early = earlyOutcome(card);
      if (early !== null) return early;

      mkdirSync(target.dir, { recursive: true });
      return withCardLock(card.file, card.rel, () => writeLockedCard(card));
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null) return { ok: false, error: text };
      throw error;
    }
  },
});
