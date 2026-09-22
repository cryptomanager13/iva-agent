import { APICallError, generateText, streamText } from "ai";
import {
  providerConfig,
  providerName,
  providerRequestHeaders,
  makeCodexModel,
  makeTextModel,
} from "./provider.ts";
import { makeClaudeCliModel } from "./lib/claude-cli.ts";

const PROMPT =
  "Опиши изображение детально и по делу: что на нём, дословный текст (OCR), важные детали и цифры. " +
  "Без преамбул и воды — только содержимое.";

// Распознаёт картинку vision-моделью ТОГО ЖЕ провайдера (на существующем доступе, без доп-подписок).
// Возвращает текстовое описание, либо "" если распознать нечем (нет ключа/vision-модели).
// Сетевые/HTTP-ошибки бросает — вызывающий ловит и продолжает ход без зрения (graceful).
export async function describeImage(
  bytes: ArrayBuffer,
  mimeType?: string,
): Promise<string> {
  // Подписки (codex, claude) мультимодальны — гоним картинку через ту же модель, что ведёт
  // ход: у codex это Responses API подписки, у claude — тот же Claude Code CLI.
  if (providerName === "codex" || providerName === "claude")
    return await describeWithSubscription(bytes, mimeType);

  const { baseURL, apiKey, visionModel } = providerConfig;
  if (!apiKey || !visionModel) return "";
  return await describeWithCompatible(bytes, mimeType, {
    baseURL,
    apiKey,
    visionModel,
  });
}

/** OpenAI-совместимый chat/completions: картинка уходит data-URL в поле image_url. */
async function describeWithCompatible(
  bytes: ArrayBuffer,
  mimeType: string | undefined,
  target: { baseURL: string; apiKey: string; visionModel: string },
): Promise<string> {
  const res = await fetch(`${target.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      "Content-Type": "application/json",
      // Go без ID диалога и User-Agent отвечает 4xx; у остальных провайдеров тут пусто.
      ...(providerRequestHeaders() ?? {}),
    },
    body: JSON.stringify({
      model: target.visionModel,
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType || "image/jpeg"};base64,${Buffer.from(bytes).toString("base64")}`,
              },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok)
    throw new Error(
      `vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Картинка моделью подписки: у codex это Responses API, у claude — тот же CLI, что ведёт ход.
 * ВАЖНО: бэкенд подписок принимает ТОЛЬКО stream:true → streamText, не generateText (иначе 400).
 */
async function describeWithSubscription(
  bytes: ArrayBuffer,
  mimeType?: string,
): Promise<string> {
  const model =
    providerName === "codex"
      ? makeCodexModel(providerConfig.visionModel)
      : makeClaudeCliModel(providerConfig.visionModel);
  const result = streamText({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          // file-part (не устаревший image-part): AI SDK кодирует его для провайдера сам.
          {
            type: "file",
            data: new Uint8Array(bytes),
            mediaType: mimeType || "image/jpeg",
          },
        ],
      },
    ],
  });
  let out = "";
  for await (const chunk of result.textStream) out += chunk;
  return out.trim();
}

// --- Видит ли картинки САМА модель чата -----------------------------------------------------
// Если видит — картинка идёт ей целиком (middleware в provider.ts), и vision-модель не
// зовём вовсе: пересказ чужими словами теряет и детали, и OCR. Если не видит — путь
// прежний, через describeImage.
//
// Ответ на это даёт только сам провайдер: одна модель тарифа берёт image_url, соседняя
// отвечает отказом. Спрашиваем одним запросом на первой картинке и помним ответ до конца
// процесса (смена модели через /model перезапускает агента, так что кэш не протухает).
//
// Спрашиваем СОДЕРЖАТЕЛЬНО, а не «прошёл ли запрос»: часть шлюзов молча выбрасывает
// картинку из тела и отвечает 200 по одному тексту. Поэтому шлём заведомо красный
// квадрат и спрашиваем цвет: назвал red — значит пиксели дошли.
const PROBE_PROMPT = "What colour is this image? Answer with one word.";
// Слово целиком: «a valid image is required» содержит red подстрокой и объявило бы
// слепую модель зрячей.
const PROBE_ANSWER = /\bred\b/iu;
// Пока вердикта нет, hasRefs истинно на КАЖДОМ шаге tool-loop, и каждый шаг платил бы
// за новый поход к молчащему провайдеру. После транзиентного сбоя держим паузу.
const PROBE_COOLDOWN_MS = 60_000;

// Сплошной красный PNG 16×16, 79 байт.
const RED_SQUARE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==",
  "base64",
);

// Статусы, которые говорят о САМОМ запросе: модель не приняла картинку как таковую.
// Только они — свойство модели, только их вердикт помним до конца процесса.
// 401/403 (ключ), 404 (имя модели), 408, 429 (лимит) и прочие 4xx — про доступ и
// нагрузку, а не про зрение: их держим наравне с обрывом сети.
const NO_IMAGE_INPUT_STATUSES = new Set([400, 415, 422]);

/** Что вернул провайдер на пробник: текст ответа и причина остановки. */
export type VisionProbeAnswer = {
  readonly text: string;
  readonly finishReason: string;
};

/**
 * Пробник с кэшем на процесс: сеть приходит аргументом, здесь только решение.
 * Ответ со словом `red` — пиксели дошли. Ответ без него при нормальной остановке и
 * статусы 400/415/422 — свойство пути к модели (картинку не приняли или выбросили),
 * помним до конца процесса. Сеть, 5xx, прочие 4xx, обрыв по таймауту и упёршийся в
 * потолок токенов ответ — не про зрение: вердикта нет, и следующая попытка идёт не
 * раньше, чем через PROBE_COOLDOWN_MS.
 */
export function makeVisionProbe(
  generate: () => Promise<VisionProbeAnswer>,
  modelName: () => string,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let verdict: boolean | undefined;
  let inFlight: Promise<boolean> | undefined;
  let coolUntil = 0;
  // Сбой не про модель: вердикт не запоминаем, но и долбиться в провайдера каждый шаг
  // tool-loop не будем.
  const transient = (...message: unknown[]): false => {
    coolUntil = now() + PROBE_COOLDOWN_MS;
    console.error(...message);
    return false;
  };
  const run = async (): Promise<boolean> => {
    let sees = false;
    try {
      const answer = await generate();
      sees = PROBE_ANSWER.test(answer.text);
      if (!sees && answer.finishReason === "length")
        // Думающая модель сожгла потолок на reasoning и до ответа не дошла. Про зрение
        // это не говорит ничего.
        return transient(
          "[vision] пробник упёрся в потолок токенов, ответа нет — эту картинку веду через vision-модель",
        );
    } catch (error) {
      const status = APICallError.isInstance(error)
        ? error.statusCode
        : undefined;
      // Таймаут и обрыв (AbortError/TimeoutError) сюда же: это не APICallError с
      // «запрос не тот», значит вердикт не запоминаем.
      if (status === undefined || !NO_IMAGE_INPUT_STATUSES.has(status))
        return transient(
          "[vision] пробник не дал ответа, эту картинку веду через vision-модель:",
          error,
        );
    }
    verdict = sees;
    console.error(`[vision] chat model ${modelName()} sees images: ${sees}`);
    return sees;
  };
  return () => {
    if (verdict !== undefined) return Promise.resolve(verdict);
    if (now() < coolUntil) return Promise.resolve(false);
    // Спросить могут одновременно: ходы разных чатов идут параллельно, и шаги tool-loop
    // одного хода тоже. Пробник при этом обязан уйти один.
    inFlight ??= run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

const probe = makeVisionProbe(
  async () => {
    const result = await generateText({
      model: makeTextModel({ chatModelSeesImages }),
      // Ответ в одно слово, но потолок высокий: думающая модель тратит на reasoning
      // сотни токенов ДО первого слова ответа, и на десятке их ответ пуст.
      maxOutputTokens: 1024,
      // Ретраи тут только тянут время: сбой сети мы и так не кэшируем.
      maxRetries: 0,
      // Молчащий провайдер не должен держать первую картинку владельца бесконечно.
      abortSignal: AbortSignal.timeout(30_000),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROBE_PROMPT },
            { type: "file", data: RED_SQUARE_PNG, mediaType: "image/png" },
          ],
        },
      ],
    });
    return { text: result.text, finishReason: result.finishReason };
  },
  () => providerConfig.textModel,
);

/** Принимает ли текстовая модель картинки. codex и claude — да без сети: подписки мультимодальны. */
export function chatModelSeesImages(): Promise<boolean> {
  if (providerName === "codex" || providerName === "claude")
    return Promise.resolve(true);
  return probe();
}
