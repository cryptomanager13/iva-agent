/** Пара коммитов вокруг чужой работы над vault: снимок «до» и результат «после».
 * Структурно это то же, что отдаёт шов в агентском дереве, но объявлено здесь: обновлятор и
 * меню обязаны грузиться на установке, где этого дерева нет или оно переписано наполовину
 * (scripts/authored-tree-guard.test.ts), поэтому агентское не импортируется статически и
 * тип шва сюда не тянется. */
export interface VaultPair {
  readonly after: () => Promise<void>;
  readonly before: () => Promise<void>;
}

/** Итог коммита подметальщика: причину отказа он печатает сам, значение нужно только для
 * журнала вызывающего. */
export type SweepResult = {
  readonly ok: boolean;
  readonly reason?: string;
};

/** Модуль шва достаётся динамическим импортом на вызове, а не на загрузке: установка без
 * агентского дерева обязана грузиться (обновлятор, меню, ночной бин). Отсутствие шва - не
 * отказ вызывающего, но и не тишина: одно объяснение в журнал, чтобы поломка модуля не
 * выглядела как «коммитить было нечего». */
async function seamModule<T>(
  take: (module: typeof import("../../agent/lib/vault-commit.ts")) => T,
): Promise<T | null> {
  try {
    return take(await import("../../agent/lib/vault-commit.ts"));
  } catch (error) {
    console.error(
      `[vault-pair] шов коммита памяти не загрузился, работы без него: ${String(error)}`,
    );
    return null;
  }
}

/** Пара коммитов вокруг чужой работы над vault (обновлятор, меню). */
export async function loadVaultPair(
  label: string,
  root: string,
): Promise<VaultPair | null> {
  return await seamModule((seam) => seam.vaultWritePair(label, root));
}

/** Ночной подметальщик: коммит всего незакоммиченного в vault. */
export async function loadVaultSweep(
  message: string,
  root: string,
): Promise<SweepResult | null> {
  return await seamModule((seam) => seam.commitVaultSweep(message, root));
}
