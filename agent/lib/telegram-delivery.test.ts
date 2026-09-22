import assert from "node:assert/strict";
import test from "node:test";
import { parseTelegramDelivery } from "./telegram-delivery.ts";

void test("a reply uses ordinary delivery unless it begins with the quiet marker", () => {
  assert.deepEqual(parseTelegramDelivery("Готово"), {
    text: "Готово",
    silent: false,
  });
  assert.deepEqual(parseTelegramDelivery("Текст\n<!-- iva:silent -->"), {
    text: "Текст\n<!-- iva:silent -->",
    silent: false,
  });
});

void test("the quiet marker is removed from the first line", () => {
  for (const lineBreak of ["\n", "\r\n"]) {
    assert.deepEqual(
      parseTelegramDelivery(`<!-- iva:silent -->${lineBreak}Готово`),
      {
        text: "Готово",
        silent: true,
      },
    );
  }
});
