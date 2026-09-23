import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "@iva/data-dir";
import { resolveTimeZone } from "@iva/timezone";

// Динамическая инструкция: каждый ход приносит текущие дату/время в часовом поясе
// пользователя user-сообщением в историю. Не в system: system входит в кэшируемый префикс
// запроса, и смена минуты в нём заново записывала бы в кэш весь запрос (#236); строка в
// истории только дописывается. Локаль следует за языком интерфейса (кнопка в /menu
// пишет data/settings.json на лету), поэтому язык пересчитывается КАЖДЫЙ турн, а не
// захватывается на загрузке модуля. Зависит только от eve, локальных пакетов и node fs/path/Intl.
const TIMEZONE = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);
const DATA_DIR = resolveDataDir(process.cwd());

// settings.language ("ru"|"en") → env AGENT_LANGUAGE → "ru". Продублировано инлайн, а
// НЕ импортом agent/lib/i18n.ts: инструкции самодостаточны (гоча eve 0.11.4 —
// authored-модули проекта тут не резолвятся). Путь относителен cwd (iva.service стартует
// с WorkingDirectory=/home/shima/iva), как VAULT в 20-core.ts. Ошибки/битый JSON молча
// → env-фолбэк.
function resolveLang(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(DATA_DIR, "settings.json"), "utf8"),
    );
    const language =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).language
        : undefined;
    if (language === "ru" || language === "en") return language;
  } catch {
    // нет файла / нет доступа / битый JSON — берём язык из env-фолбэка ниже.
  }
  return process.env.AGENT_LANGUAGE === "en" ? "en" : "ru";
}

function nowMarkdown(): string {
  const lang = resolveLang();
  const locale = lang === "en" ? "en-US" : "ru-RU";
  const formatted = new Intl.DateTimeFormat(locale, {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  return lang === "en"
    ? `Current user date and time: ${formatted}, timezone ${TIMEZONE}.`
    : `Текущая дата и время пользователя: ${formatted}, часовой пояс ${TIMEZONE}.`;
}

export default defineDynamic({
  events: {
    // turn.started — пересчитывается на каждом турне, чтобы время и локаль не «застывали».
    "turn.started": () =>
      defineInstructions({ content: nowMarkdown(), role: "user" }),
  },
});
