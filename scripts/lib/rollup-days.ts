// Какие дни ночной сводке ещё разбирать и с какого места. Прогресс ночи живёт в самом
// сыром дне (daily/YYYY-MM-DD.md), а не в сессии eve: сессию уносит карантин обновления,
// а файл дня переживает и обновление, и обрыв хода.
//
// Что писать в отметку и как резать день — суждение скилла memory-processor. Здесь
// только детерминированная половина: прочитать отметки, сказать «день сделан» или
// «продолжить после HH:MM», и выбрать пропущенные даты под потолком.

// Отметки скилл дописывает в конец сырого дня (rules/daily-format.md): отметку части
// `<!-- processed-through: HH:MM -->` после каждой разобранной части (время — заголовок её
// последней записи) и отметку конца `<!-- processed: … -->` с блоком итога. Считаются
// только строки этого служебного хвоста: отметка, процитированная внутри записи, — текст.
const PART_MARKER =
  /^<!-- processed-through: ((?:[01]\d|2[0-3]):[0-5]\d) -->$/u;
const DONE_MARKER = /^<!-- processed: .*-->$/u;
const SERVICE_LINE =
  /^(?:|<!-- processed[:-].*-->|---|(?:processed|cards|summary): .*)$/u;

// Служебный хвост: строки с конца, пока каждая — отметка, пустая строка или блок итога.
function serviceTail(raw: string): string[] {
  const lines = raw.split(/\r?\n/u).map((line) => line.trimEnd());
  let start = lines.length;
  while (start > 0 && SERVICE_LINE.test(lines[start - 1])) start--;
  return lines.slice(start);
}

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
  const tail = serviceTail(raw);
  const through =
    tail.flatMap((line) => PART_MARKER.exec(line)?.[1] ?? []).at(-1) ?? null;
  return { done: tail.some((line) => DONE_MARKER.test(line)), through };
}

// Сделан только день с отметкой конца: сводку скилл пишет раньше отметок, и обрыв между
// ними оставил бы остаток дня неразобранным. Дня без транскрипта отмечать нечем — его
// делает сводка.
export function isDayDone({ raw, summaryExists }: DayState): boolean {
  return raw === null ? summaryExists : dayProgress(raw).done;
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

// Неразобранный день, который этой ночью вышел из окна догона: его больше не возьмут,
// и об этом надо сказать, а не терять молча.
export function droppedDay(
  yesterday: string,
  read: (date: string) => DayState,
): string | null {
  const date = shiftDate(yesterday, -LOOKBACK_DAYS);
  const state = read(date);
  return state.raw !== null && !isDayDone(state) ? date : null;
}
