/** Пара коммитов вокруг чужой работы над vault: снимок «до» и результат «после».
 * Структурно это то же, что отдаёт шов в агентском дереве, но объявлено здесь: обновлятор и
 * меню обязаны грузиться на установке, где этого дерева нет или оно переписано наполовину
 * (scripts/authored-tree-guard.test.ts), поэтому агентское не импортируется статически и
 * тип шва сюда не тянется. */
export interface VaultPair {
  readonly after: () => Promise<void>;
  readonly before: () => Promise<void>;
}

/** Шов коммита памяти достаётся одним способом у обоих потребителей (обновлятор, меню):
 * динамический импорт на вызове, а не на загрузке модуля. Нет агентского дерева - чистка
 * идёт без коммитов, а не падает: файлы памяти при этом правит не шов, а сама чистка. */
export async function loadVaultPair(
  label: string,
  root: string,
): Promise<VaultPair | null> {
  try {
    const { vaultWritePair } = await import("../../agent/lib/vault-commit.ts");
    return vaultWritePair(label, root);
  } catch {
    return null;
  }
}
