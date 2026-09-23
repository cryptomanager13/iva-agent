/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";

// Тест хунка patches/eve+0.51.1.patch в formatAgentBusyMessage, не контракт апстрима
// (upstream issue: pending). Точка удаления: бамп eve, в котором busy-сообщение само
// называет следующий шаг в любой формулировке.
const eveRoot = dirname(
  createRequire(import.meta.url).resolve("eve/package.json"),
);
const { formatAgentBusyMessage } = (await import(
  join(eveRoot, "dist/src/subagents/agent-handle-errors.js")
)) as {
  formatAgentBusyMessage: (input: {
    agentName: string;
    agentId: string;
    ownerId?: string;
  }) => string;
};

const SEED = 20260923;

function tail(agentName: string, agentId: string, ownerId?: string): string {
  const prefix = `Agent "${agentName}" with id "${agentId}" is still working on`;
  const message = formatAgentBusyMessage({ agentName, agentId, ownerId });
  assert.ok(message.startsWith(prefix), message);
  return message.slice(prefix.length);
}

test("a busy agent owned by a task names the next step: end the turn or task_cancel", () => {
  assert.equal(
    tail("researcher", "agent_1", "task_42"),
    ' task "task_42". Do not call it again; its result arrives after you end this turn.' +
      ' End the turn with a one-line status, or stop it with task_cancel {"taskIds":["task_42"]}.',
  );
});

test("a busy agent without a task owner tells the model to end the turn", () => {
  const next =
    " Do not call it again in this turn; end the turn with a one-line status.";
  assert.equal(
    tail("researcher", "agent_1", undefined),
    ` another task.${next}`,
  );
  assert.equal(
    tail("researcher", "agent_1", "wrun_7"),
    ` another invocation.${next}`,
  );
});

test(`task_cancel is offered exactly when a task owns the agent (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.string(),
      fc.oneof(
        fc.string().map((s) => `task_${s}`),
        fc.string(),
        fc.constant(undefined),
      ),
      (agentName, agentId, ownerId) => {
        const rest = tail(agentName, agentId, ownerId);
        const cancel = `task_cancel ${JSON.stringify({ taskIds: [ownerId] })}`;
        assert.equal(
          rest.includes(cancel),
          ownerId?.startsWith("task_") === true,
        );
        assert.equal(
          rest.includes("task_cancel"),
          ownerId?.startsWith("task_") === true,
        );
        assert.ok(rest.includes("Do not call it again"), rest);
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});
