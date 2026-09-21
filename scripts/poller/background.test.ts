/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; async doubles preserve the I/O boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { noteDroppedBridgeTasks, scheduleBridgeTask } from "./background.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a background task starts at once and frees its slot when it finishes", async () => {
  let finish: (() => void) | undefined;
  let started = 0;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });

  assert.equal(
    scheduleBridgeTask("stop:7:", async () => {
      started += 1;
      await gate;
    }),
    true,
  );
  // Первый шаг виден сразу: цикл не должен ждать даже запуска.
  assert.equal(started, 1);
  // Пока задача в полёте, второй такой же ключ получает отказ, а не второй запуск.
  assert.equal(
    scheduleBridgeTask("stop:7:", async () => {}),
    false,
  );
  // Другой ключ — другое дело: он не ждёт чужой слот.
  assert.equal(
    scheduleBridgeTask("reset-intents", async () => {}),
    true,
  );

  finish?.();
  await tick();
  await tick();
  assert.equal(
    scheduleBridgeTask("stop:7:", async () => {}),
    true,
  );
});

test("a background task never lets its failure reach the caller", async () => {
  const logged: unknown[][] = [];
  const logImpl = (...parts: unknown[]) => logged.push(parts);

  assert.equal(
    scheduleBridgeTask(
      "throws",
      async () => {
        throw new Error("background failed");
      },
      { logImpl },
    ),
    true,
  );
  // Синхронный бросок — та же история: мост не роняет ни один фон.
  assert.equal(
    scheduleBridgeTask(
      "throws-sync",
      () => {
        throw new Error("sync failed");
      },
      { logImpl },
    ),
    true,
  );

  await tick();
  await tick();
  assert.deepEqual(
    logged.map((parts) => String(parts[0])).sort(),
    ["bridge task throws-sync threw:", "bridge task throws failed:"].sort(),
  );
});

test("a stopping bridge counts the background tasks it drops", async () => {
  const logged: unknown[][] = [];
  const logImpl = (...parts: unknown[]) => logged.push(parts);
  // Ничего в полёте — молчим: строка нужна только про брошенную работу.
  assert.equal(noteDroppedBridgeTasks({ logImpl }), 0);
  assert.deepEqual(logged, []);

  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  scheduleBridgeTask("dropped", async () => {
    await gate;
  });

  assert.equal(noteDroppedBridgeTasks({ logImpl }), 1);
  assert.deepEqual(logged, [
    ["bridge is stopping: 1 background task(s) dropped"],
  ]);
  finish?.();
  await tick();
  await tick();
});
