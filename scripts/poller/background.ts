// Фоновые задачи моста: работа, которую единственный цикл не должен ждать.
//
// Цикл моста один и последовательный (getUpdates, очередь, жнец, другие чаты), поэтому всё
// медленное — ожидание стопа, сверка интентов сброса — уходит сюда и живёт вне его такта.
// Приём один на всех: слот на ключ, ошибка уходит в журнал и не роняет мост, слот
// освобождается в finally. Ключ у каждого дела свой: сверка интентов — "reset-intents",
// «Стоп» — свой зависший ход, поэтому долгий стоп не задерживает сверку и наоборот.
//
// Задача запускается СИНХРОННО (её первый шаг виден вызывающему сразу), а ждёт её только
// этот слот: повторный вызов с тем же ключом получает false и уходит ни с чем.
const tasksInFlight = new Map<string, Promise<void>>();

type LogFn = (...parts: unknown[]) => void;

export function scheduleBridgeTask(
  key: string,
  task: () => Promise<void>,
  { logImpl = console.error as LogFn }: { logImpl?: LogFn } = {},
): boolean {
  if (tasksInFlight.has(key)) return false;
  let running: Promise<void>;
  try {
    running = task()
      .catch((error: unknown) => logImpl(`bridge task ${key} failed:`, error))
      .finally(() => {
        if (tasksInFlight.get(key) === running) tasksInFlight.delete(key);
      });
  } catch (error) {
    // Задача обязана возвращать промис: синхронный бросок не имеет права уронить мост.
    logImpl(`bridge task ${key} threw:`, error);
    return true;
  }
  tasksInFlight.set(key, running);
  return true;
}
