/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns the registrations. */
// Диалог мастера in-process: сценарий ответов вместо readline, подменный чекер портов.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { PortChecker } from "../lib/ports.ts";
import {
  createDialog,
  defaultNumber,
  envComplaint,
  listIndex,
  parsePort,
  type Dialog,
} from "./dialog.ts";

const SEED = 20260918;
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "gu");

type Script = {
  readonly dialog: Dialog;
  /** Вопросы и напечатанное, по порядку, без цветов. */
  readonly screen: string[];
  readonly left: () => number;
};

/** Диалог, который отвечает по сценарию; занятые порты — `busy`. */
function scripted(
  answers: readonly string[],
  busy: ReadonlyMap<number, string> = new Map(),
): Script {
  const queue = [...answers];
  const screen: string[] = [];
  const plain = (text: unknown) => String(text).replace(ANSI_COLOUR, "");
  const checker = new PortChecker([
    {
      name: "fake",
      check: (port) =>
        Promise.resolve(
          busy.has(port)
            ? { occupied: true, holder: busy.get(port) }
            : { occupied: false },
        ),
    },
  ]);
  const dialog = createDialog(
    {
      question: (prompt) => {
        screen.push(`? ${plain(prompt)}`);
        const answer = queue.shift();
        if (answer === undefined)
          return Promise.reject(new Error(`no answer for: ${prompt}`));
        return Promise.resolve(answer);
      },
      print: (...args) => screen.push(args.map(plain).join(" ")),
      write: (text) => screen.push(plain(text)),
    },
    checker,
  );
  dialog.setLang("en");
  return { dialog, screen, left: () => queue.length };
}

test("language: questions follow the chosen language", () => {
  const { dialog } = scripted([]);
  assert.equal(dialog.lang(), "en");
  assert.equal(dialog.t("yes", "да"), "yes");
  dialog.setLang("ru");
  assert.equal(dialog.lang(), "ru");
  assert.equal(dialog.t("yes", "да"), "да");
  assert.equal(dialog.mask("secret-key"), "secret…(оставить)");
  assert.equal(dialog.mask(""), "");
});

test("ask: typed wins, Enter takes the default, Enter or the mask keeps the current value", async () => {
  const { dialog, screen } = scripted(["  typed  ", "", "", "abcdef…(keep)"]);
  assert.equal(await dialog.ask("Name", "def"), "typed");
  assert.equal(await dialog.ask("Name", "def"), "def");
  assert.equal(
    await dialog.ask("Key", "abcdef…(keep)", "abcdef-123"),
    "abcdef-123",
  );
  assert.equal(
    await dialog.ask("Key", "abcdef…(keep)", "abcdef-123"),
    "abcdef-123",
  );
  assert.deepEqual(screen.slice(0, 2), ["? Name [def]: ", "? Name [def]: "]);
});

test("ask: failure — a value .env cannot hold is refused and asked again", async () => {
  const { dialog, screen, left } = scripted(["кириллица", "latin"]);
  assert.equal(await dialog.ask("Value"), "latin");
  assert.equal(left(), 0);
  assert.equal(screen[0], "? Value: ");
  assert.match(screen[1], /character outside the Latin alphabet/u);
});

test("ask: a current value .env cannot hold is named once and not offered on Enter", async () => {
  const { dialog, screen } = scripted([""]);
  assert.equal(await dialog.ask("Dir", "", "bad value "), "");
  assert.match(
    screen[0],
    /The value in \.env cannot stay: .*space at the start or end/u,
  );
  assert.deepEqual(screen.slice(1), ["? Dir: "]);
});

test("askYesNo: Enter takes the default, y and n answer", async () => {
  const { dialog, screen } = scripted(["", "", "y", "n"]);
  assert.equal(await dialog.askYesNo("Go?", true), true);
  assert.equal(await dialog.askYesNo("Go?"), false);
  assert.equal(await dialog.askYesNo("Go?"), true);
  assert.equal(await dialog.askYesNo("Go?", true), false);
  assert.deepEqual(screen.slice(0, 2), ["? Go? (Y/n): ", "? Go? (y/N): "]);
});

test("askYesNo: Russian «да» and «нет» answer without a complaint about Latin letters", async () => {
  const { dialog, screen } = scripted(["да", "нет"]);
  assert.equal(await dialog.askYesNo("Go?"), true);
  assert.equal(await dialog.askYesNo("Go?", true), false);
  assert.deepEqual(screen, ["? Go? (y/N): ", "? Go? (Y/n): "]);
});

test("askRequired: help, the check and ok on a good value", async () => {
  const { dialog, screen } = scripted(["key-1"]);
  const value = await dialog.askRequired("Key", {
    help: "where to get it",
    validate: (key) => Promise.resolve(key === "key-1" ? null : "bad"),
  });
  assert.equal(value, "key-1");
  assert.deepEqual(screen, [
    "where to get it",
    "? Key: ",
    "  checking… ",
    "ok",
  ]);
});

test("askRequired: failure — empty and rejected answers are asked again", async () => {
  const { dialog, screen, left } = scripted(["", "wrong", "right"]);
  const value = await dialog.askRequired("Key", {
    validate: (key) => Promise.resolve(key === "right" ? null : "key refused"),
  });
  assert.equal(value, "right");
  assert.equal(left(), 0);
  assert.ok(screen.some((line) => /Required field/u.test(line)));
  assert.ok(screen.some((line) => /not ok\n {2}⚠ key refused/u.test(line)));
});

test("askRequired: Enter keeps the current value behind its mask", async () => {
  const { dialog, screen } = scripted([""]);
  assert.equal(
    await dialog.askRequired("Key", { existing: "sk-123456789" }),
    "sk-123456789",
  );
  assert.deepEqual(screen, ["? Key [sk-123…(keep)]: "]);
});

test("pickFromList: the current item is the default, a number picks, garbage falls back", async () => {
  const { dialog, screen } = scripted(["", "3", "99", "x"]);
  const items = ["a", "b", "c"];
  assert.equal(await dialog.pickFromList(items, "b", "c"), "b");
  assert.equal(await dialog.pickFromList(items, "b", "c"), "c");
  assert.equal(await dialog.pickFromList(items, "zz", "c"), "c");
  assert.equal(await dialog.pickFromList(items, "zz", "zz"), "a");
  assert.deepEqual(screen.slice(0, 4), [
    "    1. a",
    "    2. b",
    "    3. c  ★",
    "? \n  Model number [2]: ",
  ]);
});

test("pickFromList shows a label and returns the id", async () => {
  const { dialog, screen } = scripted(["1"]);
  const picked = await dialog.pickFromList(
    [
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-opus-5", label: "Opus 5" },
    ],
    "",
    "claude-fable-5-1",
  );
  assert.equal(picked, "claude-fable-5-1");
  assert.match(screen[0] ?? "", /Fable 5\.1/u);
  assert.match(screen[0] ?? "", /★/u);
  assert.equal((screen[0] ?? "").includes("claude-fable-5-1"), false);
});

test("pickPort: a free port is taken as typed, Enter keeps the default", async () => {
  const { dialog } = scripted(["9000", ""]);
  assert.equal(await dialog.pickPort("8723"), "9000");
  assert.equal(await dialog.pickPort("8723"), "8723");
});

test("pickPort: failure — an invalid port is refused and asked again", async () => {
  const { dialog, screen } = scripted(["70000", "abc", "8080"]);
  assert.equal(await dialog.pickPort("8723"), "8080");
  assert.equal(screen.filter((line) => /Invalid port/u.test(line)).length, 2);
});

test("pickPort: the occupied current port stays only on confirmation", async () => {
  const busy = new Map([[8723, "pid 1 node"]]);
  const kept = scripted(["", "y"], busy);
  assert.equal(await kept.dialog.pickPort("8723"), "8723");
  assert.match(
    kept.screen[1],
    /Port 8723 is already occupied \(fake: pid 1 node\)/u,
  );

  const moved = scripted(["", "n", ""], busy);
  assert.equal(await moved.dialog.pickPort("8723"), "8724");
  assert.ok(moved.screen.some((line) => /Nearest free: 8724\./u.test(line)));
});

test("pickPort: a busy port offers the nearest free one; declined, the question repeats", async () => {
  const busy = new Map([[9000, ""]]);
  const { dialog, screen } = scripted(["9000", "n", "9100"], busy);
  assert.equal(await dialog.pickPort("8723"), "9100");
  assert.ok(screen.includes("  Port 9000 is busy. Nearest free: 9001."));
  assert.ok(screen.includes("?   Take 9001? (Y/n): "));
});

test("pickPort: with no free port nearby only another port helps", async () => {
  const busy = new Map(
    Array.from({ length: 60 }, (_, i) => [9000 + i, "x"] as const),
  );
  const { dialog, screen } = scripted(["9000", "9100"], busy);
  assert.equal(await dialog.pickPort("8723"), "9100");
  assert.ok(screen.includes("  Port 9000 is busy (fake: x)."));
});

test("head and hr draw a numbered step and a rule", () => {
  const { dialog, screen } = scripted([]);
  dialog.head(2, "Keys");
  dialog.hr();
  assert.equal(screen[0], "\n  Step 2/5: Keys");
  assert.match(screen[1], /^ {2}─+$/u);
});

test(`parsePort accepts exactly the integers 1..65535 and never throws (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 65535 }), (port) => {
      assert.equal(parsePort(String(port)), port);
    }),
    { seed: SEED, numRuns: 300 },
  );
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ min: -1_000_000, max: 0 }),
        fc.integer({ min: 65536, max: 10_000_000 }),
      ),
      (port) => {
        assert.equal(parsePort(String(port)), null);
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
  fc.assert(
    fc.property(fc.string(), (text) => {
      const port = parsePort(text);
      assert.ok(
        port === null || (Number.isInteger(port) && port >= 1 && port <= 65535),
      );
    }),
    { seed: SEED, numRuns: 500 },
  );
});

test(`envComplaint never throws and speaks exactly when .env refuses the value (seed ${SEED})`, () => {
  const t = (en: string) => en;
  fc.assert(
    fc.property(fc.string({ unit: "binary" }), (value) => {
      const complaint = envComplaint(t, value);
      assert.ok(complaint === null || complaint.startsWith("The value has"));
    }),
    { seed: SEED, numRuns: 500 },
  );
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9._:/@-]*$/u), (value) => {
      assert.equal(envComplaint(t, value), null);
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`list choice always lands on an item (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
      fc.string(),
      fc.string(),
      fc.string(),
      (items, current, recommended, choice) => {
        const defNum = defaultNumber(items, current, recommended);
        const idx = listIndex(choice, items.length, defNum);
        assert.ok(idx >= 0 && idx < items.length);
      },
    ),
    { seed: SEED, numRuns: 500 },
  );
});
