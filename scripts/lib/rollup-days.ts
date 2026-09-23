// Какие дни ночной сводке ещё разбирать и с какого места. Прогресс ночи живёт в самом
// сыром дне (daily/YYYY-MM-DD.md), а не в сессии eve: сессию уносит карантин обновления,
// а файл дня переживает и обновление, и обрыв хода.
//
// Что писать в отметку и как резать день — суждение скилла memory-processor. Здесь
// только детерминированная половина: прочитать отметки, сказать «день сделан» или
// «продолжить после HH:MM», и выбрать пропущенные даты под потолком.

// Отметка части: скилл дописывает её в конец сырого дня после каждой разобранной части.
// Время — заголовок последней разобранной записи (`## HH:MM`).
const PART_MARKER = /^<!-- processed-through: (\d{2}:\d{2}) -->[ \t]*$/gmu;
// Отметка конца дня — прежний маркер скилла (rules/daily-format.md).
const DONE_MARKER = /^<!-- processed: [^\n]*-->[ \t]*$/mu;

// Сколько дней назад догон ещё ищет пропуск и сколько дат берёт за один запуск.
export const LOOKBACK_DAYS = 7;
export const MAX_DAYS_PER_RUN = 3;

export interface DayProgress {
  readonly done: boolean;
  /** Время последней отметки части, или null — части ещё не отмечались. */
  readonly through: string | null;
}

export interface DayState {
  /** Текст сырого дня, или null — файла нет. */
  readonly raw: string | null;
  readonly summaryExists: boolean;
}

export function dayProgress(raw: string): DayProgress {
  let through: string | null = null;
  for (const match of raw.matchAll(PART_MARKER)) through = match[1];
  return { done: DONE_MARKER.test(raw), through };
}

// Дни, разобранные до отметок частей, несут только сводку: они сделаны. Сводка рядом с
// отметкой части — это сводка незаконченного дня, её дописывает следующий запуск.
export function isDayDone({ raw, summaryExists }: DayState): boolean {
  if (raw === null) return summaryExists;
  const progress = dayProgress(raw);
  return progress.done || (summaryExists && progress.through === null);
}

// Сдвиг ISO-даты на N дней; арифметика в UTC, без краёв перехода на летнее время.
export function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// Неразобранные дни окна, старые первыми, не больше потолка. Вчера берётся всегда, пока
// оно не сделано: тихий день без транскрипта тоже получает свою сводку, как раньше.
// Старшие дни — только с транскриптом, иначе окно свежей установки гнало бы пустые ночи.
export function pendingDays(
  yesterday: string,
  read: (date: string) => DayState,
): string[] {
  const pending: string[] = [];
  for (let back = LOOKBACK_DAYS - 1; back >= 0; back--) {
    const date = shiftDate(yesterday, -back);
    const state = read(date);
    if (isDayDone(state)) continue;
    if (state.raw === null && date !== yesterday) continue;
    pending.push(date);
  }
  return pending.slice(0, MAX_DAYS_PER_RUN);
}
