// Хаос-прогон конвертера Telegram-разметки: что видит пользователь, когда модель
// отвечает длинным текстом. Найдено 2026-09-12 маршрутом pbt/iva-deepseek-4.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: у каждого прогона свой seed в имени теста; строка вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`
// повторяет прогон байт в байт вторым аргументом fc.assert(prop, { seed, path }).
//
// КРАСНЫЙ тест здесь - это находка, а не поломка прогона: продакшн-код в этой задаче
// не меняется, предложение починки лежит в отчёте
// `.scratch/work/reviews/pbt-iva-deepseek-4-2026-09-12.md`.

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  chunkMarkdown,
  htmlToPlain,
  mdToTelegramHtml,
  toTelegramHtmlChunks,
} from "./telegram-format.ts";

const LIMIT = 3500;
const SEED = 20_260_912;

function hasLoneSurrogate(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
  });
}

// НАХОДКА 1. Длинное сообщение с эмодзи ровно на границе реза: `chunkMarkdown` режет
// строку по коду UTF-16 и разрывает суррогатную пару. Первый чанк уходит в Telegram
// с одиноким старшим суррогатом, второй - с одиноким младшим; Node кодирует их в
// UTF-8 как U+FFFD, поэтому пользователь вместо эмодзи получает два «�» на стыке
// двух сообщений. Минимальный контрпример: 3499 букв, эмодзи, хвост.
await test("НАХОДКА 1: рез длинной строки не разрывает эмодзи (контрпример)", () => {
  const source = `${"a".repeat(LIMIT - 1)}😀${"b".repeat(4)}`;
  const chunks = chunkMarkdown(source, LIMIT);
  const broken = chunks.filter(hasLoneSurrogate);
  assert.deepEqual(
    broken.map((chunk) => JSON.stringify(chunk.slice(-2))),
    [],
    "чанк обрывается одиноким суррогатом: Telegram покажет «�» на стыке сообщений",
  );
});

await test(`НАХОДКА 1: свойство «рез не рвёт суррогат» (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 3 }),
      fc.constantFrom("😀", "🎉", "🧑‍🚀"),
      (offset, emoji) => {
        const source = `${"a".repeat(LIMIT - offset)}${emoji}tail`;
        for (const chunk of chunkMarkdown(source, LIMIT))
          assert.equal(hasLoneSurrogate(chunk), false, JSON.stringify(source));
      },
    ),
    { seed: SEED, numRuns: 100 },
  );
});

// Сквозной путь отправки: outbox режет и конвертирует через toTelegramHtmlChunks.
// Здесь srcLimit = min(3500, floor(4096 * 0.85)) = 3481, поэтому эмодзи рвётся и на
// живом пути, а не только при прямом вызове chunkMarkdown.
await test("НАХОДКА 1 (сквозная): отправка длинного ответа не рвёт эмодзи", () => {
  const limit = 4096;
  const srcLimit = Math.min(3500, Math.floor(limit * 0.85));
  const source = `${"a".repeat(srcLimit - 1)}😀${"b".repeat(20)}`;
  const chunks = toTelegramHtmlChunks(source, limit);
  assert.deepEqual(
    chunks
      .filter(hasLoneSurrogate)
      .map((chunk) => JSON.stringify(chunk.slice(-2))),
    [],
    "outbox отправит одинокий суррогат: пользователь увидит «�» вместо эмодзи",
  );
});

// НАХОДКА 2. Абзац длиннее лимита перестаёт быть собой: строки абзаца склеиваются
// заново через пустую строку. Длинный блок кода приезжает с пустой строкой после
// каждой строки кода, а фраза-забор ``` остаётся в одиночном чанке - и получает
// отдельное сообщение `<pre></pre>` (пустой блок кода). Минимальный контрпример:
// две строки, вместе чуть длиннее лимита.
await test("НАХОДКА 2: длинный абзац не получает пустых строк между строками", () => {
  // Минимальный контрпример из свойства: строка длиннее лимита и хвост, которые
  // раньше склеивались в один чанк через "\n\n".
  const source = `${"x".repeat(LIMIT + 1)}\n `;
  const chunks = chunkMarkdown(source, LIMIT);
  assert.equal(
    chunks.some((chunk) => chunk.includes("\n\n")),
    false,
    "рез вставил пустую строку",
  );
  assert.equal(
    chunks.join("").replace(/\n/g, ""),
    source.replace(/\n/g, ""),
    "рез потерял или переставил символы",
  );
});

await test(`НАХОДКА 2: свойство «чанки - разбиение текста» (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc
        .string({ minLength: 1, maxLength: 5 })
        .filter((s) => !s.includes("\n")),
      (extra, tail) => {
        // Гарантированно длинный первый абзац: pre-условие здесь не нужно, иначе
        // генератор малых строк скипает почти все прогоны.
        const source = `${"x".repeat(LIMIT + extra)}\n${tail}`;
        const chunks = chunkMarkdown(source, LIMIT);
        // Пустых строк рез не добавляет, а текст (без переводов строк, которые
        // остаются разделителями сообщений) сохраняет целиком и в порядке.
        assert.equal(
          chunks.some((chunk) => chunk.includes("\n\n")),
          false,
        );
        assert.equal(
          chunks.join("").replace(/\n/g, ""),
          source.replace(/\n/g, ""),
        );
      },
    ),
    { seed: SEED, numRuns: 200 },
  );
});

await test("НАХОДКА 2 (следствие): длинный блок кода не превращается в пустой <pre></pre>", () => {
  const code = Array.from(
    { length: 400 },
    (_, index) => `const v${index} = ${index};`,
  ).join("\n");
  const chunks = toTelegramHtmlChunks(`\`\`\`js\n${code}\n\`\`\`\n`, 4096);
  assert.equal(
    htmlToPlain(chunks[0]).includes("\n\n"),
    false,
    "строки кода разъехались пустыми строками",
  );
  // Вторая половина находки: если единственная строка блока кода длиннее лимита,
  // фраза-забор уезжает отдельным чанком и Telegram получает пустой блок кода.
  const single = toTelegramHtmlChunks(
    `\`\`\`\n${"a".repeat(4000)}\n\`\`\``,
    4096,
  );
  assert.deepEqual(
    single.filter((chunk) => htmlToPlain(chunk).trim() === ""),
    [],
    "пользователь получает пустое сообщение (пустой блок кода)",
  );
});

// Зелёные свойства того же конвертера: подтверждают, что находки не «тест не понял
// контракт», а именно поломки. Эти инварианты держатся и без починки.
await test("зелёное: чанк не длиннее лимита и не теряет текст при обычной разметке", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("a", "b", " ", "**", "_", "`", "😀"), {
        minLength: 1,
        maxLength: 2000,
      }),
      (units) => {
        const source = units.join("");
        for (const chunk of toTelegramHtmlChunks(source, 4096))
          assert.ok(chunk.length <= 4096, String(chunk.length));
      },
    ),
    { seed: SEED, numRuns: 100 },
  );
});

await test("зелёное: пользовательский HTML экранируется, а не исполняется", () => {
  for (const raw of ["<b>x</b>", "<script>alert(1)</script>", "a < b & c > d"])
    assert.equal(
      htmlToPlain(mdToTelegramHtml(raw)),
      raw,
      "разметка пользователя не должна превращаться в HTML-теги",
    );
});

// НАХОДКА 4 (латентная). Конвертер на строке из одних `[` рос квадратично:
// 20 000 знаков - 340 мс, 80 000 - 3 700 мс, 200 000 - 41 секунда. Outbox зовёт
// конвертер через toTelegramHtmlChunks, а тот сначала режет текст на чанки по 3500,
// поэтому живой путь ограничен и не висит; но сама mdToTelegramHtml экспортирована и
// документирована как самостоятельная, и любой прямой вызов большого текста
// останавливал бы однопоточный мост на десятки секунд. Тест сравнивает рост времени,
// а не абсолютные миллисекунды: восьмикратный вход при линейном росте даёт ~8x, при
// прежнем росте ~35x, порог 24x. Время - процессорное (process.cpuUsage), а не по
// часам: соседние тест-процессы под покрытием отнимают у этого процесса ядро, и по
// часам 80 000 знаков однажды заняли 12x от 20 000. Из трёх замеров берётся
// наименьший: шум (сборка мусора) только добавляет время.
const cpuMs = (run: () => void): number => {
  const start = process.cpuUsage();
  run();
  const spent = process.cpuUsage(start);
  return (spent.user + spent.system) / 1000;
};
const fastestCpuMs = (run: () => void): number =>
  Math.min(cpuMs(run), cpuMs(run), cpuMs(run));

await test("НАХОДКА 4 (латентная): конвертер не тормозит квадратично на скобках", () => {
  const warmup = mdToTelegramHtml("[".repeat(1000));
  assert.equal(warmup.length, 1000);
  const smallMs = fastestCpuMs(() => mdToTelegramHtml("[".repeat(10_000)));
  const largeMs = fastestCpuMs(() => mdToTelegramHtml("[".repeat(80_000)));
  assert.ok(
    largeMs < smallMs * 24,
    `вход вырос в 8 раз, время в ${(largeMs / smallMs).toFixed(1)} раза (${smallMs.toFixed(0)}мс -> ${largeMs.toFixed(0)}мс) - рост быстрее линейного`,
  );
});
