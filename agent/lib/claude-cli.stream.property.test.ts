/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Поток блоков шага claude проверяется генератором: события stream-json приходят из чужого
// процесса, и их порядок, индексы и пустые куски никто не обещает. Генератор даёт несколько
// сообщений за запуск, блоки всех видов (и неизвестного), дельты всех видов (и пустые),
// индексы, которые никто не открывал, `ping` и чужие типы событий.
//
// Seed печатается: без него падение PBT не воспроизвести. Прогонов 300 (IVA_CLAUDE_PBT_RUNS),
// seed можно задать IVA_CLAUDE_PBT_SEED.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  BlockStream,
  CLAUDE_TOOL_PREFIX,
  ClaudeCliError,
} from "./claude-cli.ts";

const SEED = Number(process.env.IVA_CLAUDE_PBT_SEED ?? 20_260_923);
const RUNS = Number(process.env.IVA_CLAUDE_PBT_RUNS ?? 300);

type Native = Record<string, unknown>;
type Kind = "reasoning" | "tool";

// Индексов мало нарочно: дельта должна часто попадать в открытый блок, а не только мимо.
const index = fc.integer({ min: 0, max: 2 });
const chunk = fc.oneof(fc.constant(""), fc.string({ maxLength: 6 }));

const blockArbitrary: fc.Arbitrary<Native> = fc.oneof(
  fc.constant({ type: "text", text: "" }),
  fc.constant({ type: "thinking", thinking: "" }),
  fc.constant({ type: "redacted_thinking", data: "x" }),
  fc.record({
    type: fc.constant("tool_use"),
    name: fc.oneof(
      fc
        .stringMatching(/^[a-z_]{1,8}$/u)
        .map((name) => CLAUDE_TOOL_PREFIX + name),
      fc.constantFrom("Bash", "Read", "mcp__other__x"),
    ),
    input: fc.constant({}),
  }),
  fc.constant({ type: "server_tool_use_future" }),
);

const deltaArbitrary: fc.Arbitrary<Native> = fc.oneof(
  chunk.map((text) => ({ type: "text_delta", text })),
  chunk.map((thinking) => ({ type: "thinking_delta", thinking })),
  chunk.map((signature) => ({ type: "signature_delta", signature })),
  chunk.map((partial_json) => ({ type: "input_json_delta", partial_json })),
  fc.constant({ type: "citations_delta_future" }),
);

const eventArbitrary: fc.Arbitrary<Native> = fc.oneof(
  fc.constant({ type: "message_start", message: { id: "msg" } }),
  fc.constant({ type: "ping" }),
  fc.constant({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
  fc.constant({ type: "message_stop" }),
  fc.constant({ type: "mystery_event" }),
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("content_block_start"),
      index,
      content_block: blockArbitrary,
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      type: fc.constant("content_block_delta"),
      index,
      delta: deltaArbitrary,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("content_block_stop"), index }),
  },
);

/**
 * id вызова — от API и за запуск не повторяется; повтор и пустой id ловит сверка с пойманным
 * ответом, а не поток блоков. Поэтому id раздаются по месту события.
 */
function withToolIds(events: readonly Native[]): Native[] {
  return events.map((event, at) => {
    const block = event.content_block as Native | undefined;
    return block?.type === "tool_use"
      ? { ...event, content_block: { ...block, id: `toolu_${at}` } }
      : event;
  });
}

function endOf(block: { kind: Kind; id: string }): LanguageModelV4StreamPart {
  return {
    type: block.kind === "reasoning" ? "reasoning-end" : "tool-input-end",
    id: block.id,
  };
}

/** Какой блок вправе нести какую дельту и какое её поле. */
const DELTA_OF: Record<Kind, readonly [string, string]> = {
  reasoning: ["thinking_delta", "thinking"],
  tool: ["input_json_delta", "partial_json"],
};

function kindOf(part: LanguageModelV4StreamPart): Kind | undefined {
  if (part.type.startsWith("reasoning-")) return "reasoning";
  if (part.type.startsWith("tool-input-")) return "tool";
  return undefined;
}

function idOf(part: LanguageModelV4StreamPart): string {
  return (part as { id: string }).id;
}

function field(record: Native, key: string): unknown {
  return record[key];
}

test("поток блоков отдаёт каждую содержательную дельту сразу и не выдумывает частей", () => {
  console.error(`[claude-cli stream property] seed ${SEED}, прогонов ${RUNS}`);
  fc.assert(
    fc.property(
      fc.array(eventArbitrary, { maxLength: 60, size: "max" }).map(withToolIds),
      (events) => {
        const parts: LanguageModelV4StreamPart[] = [];
        const blocks = new BlockStream({ enqueue: (part) => parts.push(part) });
        // Модель теста: какой блок сейчас открыт на каком индексе — по тем началам, что вышли.
        const open = new Map<number, { kind: Kind; id: string }>();
        // Начатые вызовы, с которыми сверка сравнит пойманный ответ.
        const tools: { id: string; name: string }[] = [];
        for (const event of events) {
          const before = parts.length;
          let thrown: unknown;
          try {
            blocks.apply(event);
          } catch (error) {
            thrown = error;
          }
          const emitted = parts.slice(before);
          const at = typeof event.index === "number" ? event.index : -1;
          if (event.type === "content_block_start") {
            const block = event.content_block as Native;
            // Новое начало на занятом индексе сперва закрывает прежний блок.
            const prior = open.get(at);
            open.delete(at);
            const ends = prior === undefined ? [] : [endOf(prior)];
            if (block.type === "tool_use") {
              const name = String(block.name);
              const id = String(block.id);
              if (!name.startsWith(CLAUDE_TOOL_PREFIX)) {
                // (d) Имя без префикса — отказ шага, и начала вызова нет.
                assert.ok(
                  thrown instanceof ClaudeCliError,
                  "отказ — ошибка шага",
                );
                assert.deepEqual(
                  emitted,
                  ends,
                  "отказ не выпускает начала вызова",
                );
                break;
              }
              assert.deepEqual(emitted, [
                ...ends,
                {
                  type: "tool-input-start",
                  id,
                  toolName: name.slice(CLAUDE_TOOL_PREFIX.length),
                },
              ]);
              open.set(at, { kind: "tool", id });
              tools.push({ id, name: name.slice(CLAUDE_TOOL_PREFIX.length) });
            } else if (
              block.type === "thinking" ||
              block.type === "redacted_thinking"
            ) {
              const start = emitted[emitted.length - 1];
              assert.deepEqual(emitted.slice(0, -1), ends);
              assert.equal(start?.type, "reasoning-start");
              open.set(at, { kind: "reasoning", id: idOf(start) });
            } else {
              assert.deepEqual(
                emitted,
                ends,
                "текст и неизвестные блоки своих частей не дают",
              );
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.delta as Native;
            const block = open.get(at);
            const [type, key] =
              block === undefined ? ["", ""] : DELTA_OF[block.kind];
            const value = field(delta, key);
            if (
              block !== undefined &&
              delta.type === type &&
              typeof value === "string" &&
              value !== ""
            ) {
              // (a) Непустая дельта по открытому блоку своего вида — ровно одна *-delta с его id.
              assert.deepEqual(emitted, [
                {
                  type:
                    block.kind === "reasoning"
                      ? "reasoning-delta"
                      : "tool-input-delta",
                  id: block.id,
                  delta: value,
                },
              ]);
            } else {
              // (c), (h) Пустая, чужого вида или по неоткрытому индексу — ни одной части.
              assert.deepEqual(emitted, []);
            }
          } else if (event.type === "content_block_stop") {
            const block = open.get(at);
            assert.deepEqual(
              emitted,
              block === undefined ? [] : [endOf(block)],
            );
            open.delete(at);
          } else if (event.type === "message_start") {
            // Новое сообщение закрывает блоки прежнего, которые CLI не закрыл, и только их.
            assert.deepEqual(emitted, [...open.values()].map(endOf));
            open.clear();
          } else {
            // (c) ping, message_* и неизвестные типы частей не дают.
            assert.deepEqual(emitted, []);
          }
          assert.equal(
            thrown,
            undefined,
            "бросает только отказ на старте вызова",
          );
        }
        blocks.close();
        assert.deepEqual(blocks.tools, tools);
        assertLifecycle(parts);
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});

/** (b), (e), (f), (g): у каждой части блока есть начало, конец один и последний, id вызовов не повторяются. */
function assertLifecycle(parts: readonly LanguageModelV4StreamPart[]): void {
  const started = new Set<string>();
  const ended = new Set<string>();
  const toolStarts: string[] = [];
  for (const part of parts) {
    const kind = kindOf(part);
    assert.notEqual(
      kind,
      undefined,
      "поток блоков выпускает только reasoning-* и tool-input-*",
    );
    const id = idOf(part);
    assert.equal(
      ended.has(id),
      false,
      `после конца блока ${id} ничего не приходит`,
    );
    if (part.type.endsWith("-start")) {
      assert.equal(started.has(id), false, `начало блока ${id} одно`);
      started.add(id);
      if (part.type === "tool-input-start") toolStarts.push(id);
      continue;
    }
    assert.ok(started.has(id), `${part.type} по ${id} пришла после начала`);
    if (part.type.endsWith("-end")) ended.add(id);
  }
  assert.equal(
    new Set(toolStarts).size,
    toolStarts.length,
    "id вызовов не повторяются",
  );
  // После close каждый начатый блок закрыт ровно одним концом.
  assert.deepEqual([...ended].sort(), [...started].sort());
}
