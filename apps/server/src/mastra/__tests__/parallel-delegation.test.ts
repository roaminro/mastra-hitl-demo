import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { MockLanguageModelV3 } from 'ai/test';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

// Minimal structural type for v3 provider stream parts (avoids a direct
// @ai-sdk/provider dependency; we only emit a small subset of chunk types).
type LanguageModelV3StreamPart = Record<string, any>;

/**
 * Regression / invariant test for parallel sub-agent delegation isolation.
 *
 * Background (observed live, support-copilot demo, @mastra/core 1.41.0 + real
 * OpenRouter models): when the supervisor emitted TWO delegations to the SAME
 * sub-agent (agent-billingAgent) in one assistant step, the two results
 * cross-contaminated — both showed identical inner tool-call IDs and the second
 * delegation (ord_2003) echoed the first's (ord_2001) result. Running the same
 * request serially worked correctly. See ISSUE_PARALLEL_DELEGATION_COLLISION.md.
 *
 * This test drives the exact delegation code path deterministically with mock
 * models (two parallel delegations to one sub-agent, each with its own order),
 * with the supervisor running WITH memory and the inner runs forced to overlap
 * in time. It asserts the isolation invariant: each delegation's result must
 * reference the order it was asked about, and inner tool-call IDs must be unique
 * per run.
 *
 * IMPORTANT FINDING: with mock models, the parallel path in 1.41.0 is correctly
 * isolated — this test PASSES. That means the live collision is NOT a pure
 * structural race the mocks reproduce; it is driven by real model/provider
 * behavior (e.g. the sub-agent model returning duplicate tool-call IDs across
 * concurrent runs) or a timing window not hit deterministically. The test is
 * kept as a guard: if a future change breaks structural isolation, it will fail.
 */

const ORDER_A = 'ord_AAA';
const ORDER_B = 'ord_BBB';

// ---------------------------------------------------------------------------
// Helpers to build deterministic v3 model streams.
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
  totalTokens: 20,
} as const;

function streamOf(chunks: LanguageModelV3StreamPart[]): any {
  return {
    stream: new ReadableStream<any>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
  };
}

function textStep(id: string, text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id, modelId: 'mock', timestamp: new Date(0) },
    { type: 'text-start', id: `t-${id}` },
    { type: 'text-delta', id: `t-${id}`, delta: text },
    { type: 'text-end', id: `t-${id}` },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
  ];
}

function toolCallStep(
  responseId: string,
  calls: { toolCallId: string; toolName: string; input: unknown }[],
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: responseId, modelId: 'mock', timestamp: new Date(0) },
  ];
  for (const c of calls) {
    parts.push({ type: 'tool-input-start', id: c.toolCallId, toolName: c.toolName });
    parts.push({ type: 'tool-input-delta', id: c.toolCallId, delta: JSON.stringify(c.input) });
    parts.push({ type: 'tool-input-end', id: c.toolCallId });
    parts.push({
      type: 'tool-call',
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: JSON.stringify(c.input),
    });
  }
  parts.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE });
  return parts;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Extracts the order id this delegation prompt is about. */
function orderFromPrompt(prompt: string): string {
  const match = prompt.match(/ord_[A-Za-z0-9]+/);
  return match ? match[0] : 'ord_UNKNOWN';
}

// ---------------------------------------------------------------------------
// Sub-agent: a deterministic "billing" worker.
//
// Its model reads the incoming user prompt, finds the order id, calls a tool
// with THAT order id, then reports the order id back. If state is isolated,
// each delegation must process the order it was asked about.
// ---------------------------------------------------------------------------

function buildSubAgent(opts: { collidingInnerIds?: boolean } = {}) {
  const processOrderTool = createTool({
    id: 'process-order',
    description: 'Process the given order.',
    inputSchema: z.object({ orderId: z.string() }),
    outputSchema: z.object({ orderId: z.string(), processed: z.boolean() }),
    execute: async ({ orderId }) => {
      // Hold the run open so the two parallel delegations are guaranteed to be
      // in flight at the same time, maximizing the chance that shared
      // agent-instance / requestContext state collides.
      await delay(50);
      return { orderId, processed: true };
    },
  });

  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      call += 1;
      // The latest user message text is the delegation prompt.
      const text = JSON.stringify(prompt);
      const order = orderFromPrompt(text);
      // First model turn for this run: emit a tool call for the order.
      // Second turn (after tool result): report the order id back.
      // We distinguish turns by whether a tool result is already in the prompt.
      const hasToolResult = text.includes('tool-result') || text.includes('"processed"');
      if (!hasToolResult) {
        await delay(50);
        // When `collidingInnerIds` is set, every concurrent run emits the SAME
        // inner tool-call id — mimicking a real provider that reused ids across
        // the two parallel sub-agent runs (as seen in the live transcript).
        const innerId = opts.collidingInnerIds ? 'tc-shared' : `tc-${order}-${call}`;
        return streamOf(
          toolCallStep(`sub-call-${order}-${call}`, [
            {
              toolCallId: innerId,
              toolName: 'process-order',
              input: { orderId: order },
            },
          ]),
        );
      }
      return streamOf(textStep(`sub-final-${order}-${call}`, `Processed ${order}.`));
    },
  });

  return new Agent({
    id: 'sub-agent',
    name: 'Sub Agent',
    description: 'Processes a single order. Delegate one order at a time.',
    instructions: 'Process the order in the prompt by calling process-order, then report which order you processed.',
    model,
    tools: { processOrderTool },
  });
}

// ---------------------------------------------------------------------------
// Supervisor: emits two delegations to the same sub-agent.
//
// `parallel = true`  -> both delegations in ONE assistant step (reproduces bug)
// `parallel = false` -> one delegation per step, sequentially (control)
// ---------------------------------------------------------------------------

function buildSupervisor(subAgent: Agent, parallel: boolean) {
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      if (parallel) {
        if (step === 1) {
          return streamOf(
            toolCallStep('sup-1', [
              {
                toolCallId: 'sup-tc-A',
                toolName: 'agent-subAgent',
                input: { prompt: `Process order ${ORDER_A}.`, maxSteps: 3 },
              },
              {
                toolCallId: 'sup-tc-B',
                toolName: 'agent-subAgent',
                input: { prompt: `Process order ${ORDER_B}.`, maxSteps: 3 },
              },
            ]),
          );
        }
        return streamOf(textStep('sup-final', 'Both orders processed.'));
      }
      // Serial control: one delegation per step.
      if (step === 1) {
        return streamOf(
          toolCallStep('sup-1', [
            {
              toolCallId: 'sup-tc-A',
              toolName: 'agent-subAgent',
              input: { prompt: `Process order ${ORDER_A}.`, maxSteps: 3 },
            },
          ]),
        );
      }
      if (step === 2) {
        return streamOf(
          toolCallStep('sup-2', [
            {
              toolCallId: 'sup-tc-B',
              toolName: 'agent-subAgent',
              input: { prompt: `Process order ${ORDER_B}.`, maxSteps: 3 },
            },
          ]),
        );
      }
      return streamOf(textStep('sup-final', 'Both orders processed.'));
    },
  });

  return new Agent({
    id: 'supervisor',
    name: 'Supervisor',
    instructions: 'Delegate each order to the sub agent.',
    model,
    agents: { subAgent },
    // The collision path in core only activates when the supervisor runs WITH
    // memory (resourceId && threadId): it then save/deletes/restores shared
    // requestContext keys and injects its memory into the sub-agent. A
    // fresh in-memory LibSQL store keeps the test self-contained.
    memory: new Memory({
      storage: new LibSQLStore({ id: 'test-mem', url: ':memory:' }),
    }),
  });
}

let threadSeq = 0;
function memoryOpts() {
  threadSeq += 1;
  return { resource: 'rep_test', thread: `t-${threadSeq}` };
}

/** Collect every agent-subAgent delegation result from the run steps. */
async function collectDelegations(result: Awaited<ReturnType<Agent['stream']>>) {
  const delegations: { promptOrder: string; resultOrder: string; innerToolCallIds: string[] }[] = [];
  const steps = await result.steps;
  for (const s of steps) {
    for (const tr of s.toolResults ?? []) {
      const payload: any = (tr as any).payload ?? tr;
      if (payload.toolName !== 'agent-subAgent') continue;
      const promptOrder = orderFromPrompt(JSON.stringify(payload.args ?? {}));
      const out: any = payload.result ?? {};
      const resultOrder = orderFromPrompt(JSON.stringify(out));
      const innerToolCallIds = (out.subAgentToolResults ?? []).map((r: any) => r.toolCallId);
      delegations.push({ promptOrder, resultOrder, innerToolCallIds });
    }
  }
  return delegations;
}

describe('parallel sub-agent delegation', () => {
  it('CONTROL: serial delegations stay isolated', async () => {
    const sub = buildSubAgent();
    const sup = buildSupervisor(sub, false);

    const result = await sup.stream('Process both orders, one at a time.', {
      maxSteps: 6,
      memory: memoryOpts(),
    });
    await result.text; // drain
    const delegations = await collectDelegations(result);

    expect(delegations).toHaveLength(2);
    for (const d of delegations) {
      // Each delegation's result references the order it was asked about.
      expect(d.resultOrder).toBe(d.promptOrder);
    }
    // Distinct orders, distinct inner tool-call ids.
    const orders = delegations.map(d => d.resultOrder).sort();
    expect(orders).toEqual([ORDER_A, ORDER_B]);
    const allInner = delegations.flatMap(d => d.innerToolCallIds);
    expect(new Set(allInner).size).toBe(allInner.length);
  });

  it('INVARIANT: parallel delegations to the same sub-agent must not cross-contaminate', async () => {
    const sub = buildSubAgent();
    const sup = buildSupervisor(sub, true);

    const result = await sup.stream('Process both orders in parallel.', {
      maxSteps: 6,
      memory: memoryOpts(),
    });
    await result.text; // drain
    const delegations = await collectDelegations(result);

    expect(delegations).toHaveLength(2);

    // Each delegation must report the order it was asked to process.
    for (const d of delegations) {
      expect(d.resultOrder).toBe(d.promptOrder);
    }

    // Both orders must be represented exactly once.
    const orders = delegations.map(d => d.resultOrder).sort();
    expect(orders).toEqual([ORDER_A, ORDER_B]);

    // Inner tool-call ids must be unique across the two isolated runs.
    const allInner = delegations.flatMap(d => d.innerToolCallIds);
    expect(new Set(allInner).size).toBe(allInner.length);
  });

  it('PROVIDER-COLLISION: duplicate inner tool-call ids across parallel runs must not leak results', async () => {
    // Mimics the live failure: both concurrent sub-agent runs emit the SAME
    // inner tool-call id. If core keys any shared state by inner toolCallId,
    // run B will read run A's result and the orders will cross over.
    const sub = buildSubAgent({ collidingInnerIds: true });
    const sup = buildSupervisor(sub, true);

    const result = await sup.stream('Process both orders in parallel.', {
      maxSteps: 6,
      memory: memoryOpts(),
    });
    await result.text; // drain
    const delegations = await collectDelegations(result);

    expect(delegations).toHaveLength(2);

    // The invariant: each delegation still reports the order it was asked about,
    // even though the sub-agent reused inner tool-call ids.
    for (const d of delegations) {
      expect(d.resultOrder).toBe(d.promptOrder);
    }
    const orders = delegations.map(d => d.resultOrder).sort();
    expect(orders).toEqual([ORDER_A, ORDER_B]);
  });
});
