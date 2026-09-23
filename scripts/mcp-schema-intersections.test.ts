import assert from "node:assert/strict";
import { test } from "node:test";
import { asSchema, generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { toInputSchema } from "../node_modules/eve/dist/src/tools/schema.js";

void test("MCP allOf input schemas survive conversion on successive model steps", async () => {
  const sources = [
    { allOf: [{ properties: { limit: { maximum: 100 } } }] },
    {
      type: "object",
      allOf: [
        { properties: { query: { type: "string" } }, required: ["query"] },
        { properties: { limit: { type: "integer", maximum: 100 } } },
      ],
    },
  ];

  const model = new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "ответ" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
  });

  for (const source of sources) {
    const tool = toInputSchema(source);
    assert.ok(asSchema(tool).jsonSchema);
    const reply = await generateText({
      model,
      prompt: "Привет",
      tools: { mcp: { inputSchema: tool } },
    });
    assert.equal(reply.text, "ответ");
  }
  assert.equal(model.doGenerateCalls.length, sources.length);
});
