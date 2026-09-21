// Плагин hybrid-retrieval: dense-эмбеддинги через ОДИН внешний ключ (Jina ИЛИ DeepInfra).
// Оба OpenAI-совместимы → тот же паттерн, что agent/provider.ts (env→frozen config). Локальной
// RAM ноль (внешний API), стоит центы/мес. Активно только при MEMORY_SEARCH_MODE=hybrid.
// cross-encoder rerank НЕ включён по умолчанию (RRF над BM25+dense уже +15-30% recall).

interface EmbedProvider {
  url: string;
  key: string | undefined;
  model: string;
}

// Выбор провайдера: явный MEMORY_EMBED_PROVIDER, иначе — по наличию ключа (Jina в приоритете:
// no-train, EU). MEMORY_EMBED_URL переопределяет эндпоинт на любой OpenAI-совместимый (напр.
// локальный Ollama /v1/embeddings — тогда ключ не нужен). Нет ни ключа, ни URL → hasEmbeddingKey()
// false, вызывающий уходит в BM25.
function pickProvider(): { name: string; cfg: EmbedProvider } {
  const explicit = process.env.MEMORY_EMBED_PROVIDER;
  const name = explicit || (process.env.JINA_API_KEY ? "jina" : "deepinfra");
  const providers: Record<string, EmbedProvider> = {
    jina: {
      url: "https://api.jina.ai/v1/embeddings",
      key: process.env.JINA_API_KEY,
      model: process.env.MEMORY_EMBED_MODEL || "jina-embeddings-v3",
    },
    deepinfra: {
      url: "https://api.deepinfra.com/v1/openai/embeddings",
      key: process.env.DEEPINFRA_API_KEY,
      model: process.env.MEMORY_EMBED_MODEL || "BAAI/bge-m3",
    },
  };
  const cfg = providers[name] ?? providers.deepinfra;
  if (process.env.MEMORY_EMBED_URL) cfg.url = process.env.MEMORY_EMBED_URL;
  return { name: process.env.MEMORY_EMBED_URL ? `${name}@custom` : name, cfg };
}

export function hasEmbeddingKey(): boolean {
  const { cfg } = pickProvider();
  return Boolean(cfg.key || process.env.MEMORY_EMBED_URL); // custom endpoint may need no key
}

export function embeddingProviderName(): string {
  return pickProvider().name;
}

// Имя модели, которой считаются векторы. Нужно тому, кто хранит их между запусками
// (scripts/memory/embed-index.ts): векторы разных моделей несравнимы, смена модели
// обязана пересчитать индекс целиком, а не подмешать чужое пространство к своему.
export function embeddingModelName(): string {
  return pickProvider().cfg.model;
}

// Кастомный эндпоинт (MEMORY_EMBED_URL) может быть без ключа, а без ключа и без URL
// эмбеддинги недоступны вовсе: вызывающий уходит в чистый BM25.
function assertEmbeddingEndpoint(cfg: EmbedProvider): void {
  if (!cfg.key && !process.env.MEMORY_EMBED_URL)
    throw new Error(
      "no embedding API key (JINA_API_KEY / DEEPINFRA_API_KEY) or MEMORY_EMBED_URL",
    );
}

// Батчами (эмбеддинг-эндпоинты OpenAI-совместимы: {input: string[], model}). Бросает при
// сетевой/HTTP-ошибке — вызывающий (memory_search) ловит и уходит в чистый BM25 (graceful).
// signal — отмена хода: обрывает текущий запрос и не пускает следующие батчи, каждый из
// которых стоит денег.
export async function embedTexts(
  texts: string[],
  { batchSize = 64, signal }: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<number[][]> {
  const { cfg } = pickProvider();
  assertEmbeddingEndpoint(cfg);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`; // custom endpoint может быть без auth
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    signal?.throwIfAborted(); // отмена между батчами: следующий вызов не уходит
    const batch = texts.slice(i, i + batchSize);
    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: batch }),
      signal,
    });
    if (!res.ok)
      throw new Error(
        `embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    const json = (await res.json()) as {
      data?: Array<{ embedding: number[] }>;
    };
    for (const d of json.data ?? []) out.push(d.embedding);
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
