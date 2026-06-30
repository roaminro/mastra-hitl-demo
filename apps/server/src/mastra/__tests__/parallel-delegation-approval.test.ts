import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { MockLanguageModelV3 } from 'ai/test';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

/**
 * DETERMINISTIC reproduction of the parallel sub-agent delegation
 * suspend/resume collision (no real LLM required).
 *
 * Background: the structural delegation path is correctly isolated (see
 * parallel-delegation.test.ts — all green). The live failure
 * (parallel-delegation.live.test.ts) showed the bug actually lives in the
 * SUSPEND/RESUME (approval) path: when a supervisor emits TWO parallel
 * delegations to the same sub-agent, and the sub-agent's tool requires
 * approval, BOTH delegations suspend their own inner sub-agent run while
 * sharing ONE outer supervisor run. Approving the first advances the shared
 * outer run to completion, which tears down the SECOND sub-agent's suspended
 * snapshot. The second approveToolCall() then fails with
 * AGENT_RESUME_NO_SNAPSHOT_FOUND and its tool never executes.
 *
 * This test reproduces that exact path deterministically with mock models:
 *  - sub-agent has a `process-order` tool with `requireApproval: true`
 *  - supervisor emits two parallel `agent-subAgent` delegations in one step
 *  - we collect both approval requests, then approve them one at a time
 *
 * EXPECTED (correct) behavior: both orders process.
 * ACTUAL (buggy) behavior on @mastra/core 1.42.0: only ONE order processes;
 * the second approval fails to resume.
 */

const ORDER_A = 'ord_AAA';
const ORDER_B = 'ord_BBB';

// Ledger of orders that actually got processed (i.e. their approved tool ran).
const processedOrders: string[] = [];

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
  totalTokens: 20,
} as const;

type LanguageModelV3StreamPart = Record<string, any>;

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

/** Extracts the order id this delegation prompt is about. */
function orderFromText(text: string): string {
  const match = text.match(/ord_[A-Za-z0-9]+/);
  return match ? match[0] : 'ord_UNKNOWN';
}

// ---------------------------------------------------------------------------
// Sub-agent: emits a process-order tool call (which requires approval, so it
// suspends), then on resume reports the processed order.
// ---------------------------------------------------------------------------

function buildSubAgent() {
  const processOrderTool = createTool({
    id: 'process-order',
    description: 'Process the given order. Requires human approval.',
    inputSchema: z.object({ orderId: z.string() }),
    outputSchema: z.object({ orderId: z.string(), processed: z.boolean() }),
    // This is the key: the tool suspends for approval, exactly like
    // issue-refund in the demo. The suspend/resume cycle is where the bug
    // lives.
    requireApproval: true,
    execute: async ({ orderId }) => {
      processedOrders.push(orderId);
      return { orderId, processed: true };
    },
  });

  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const text = JSON.stringify(prompt);
      const order = orderFromText(text);
      // If the tool's result is already in the conversation, report back.
      const hasToolResult = text.includes('"processed"');
      if (!hasToolResult) {
        return streamOf(
          toolCallStep(`sub-call-${order}`, [
            {
              toolCallId: `tc-${order}`,
              toolName: 'process-order',
              input: { orderId: order },
            },
          ]),
        );
      }
      return streamOf(textStep(`sub-final-${order}`, `Processed ${order}.`));
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
// Supervisor: emits two parallel delegations to the same sub-agent in one step.
// ---------------------------------------------------------------------------

function buildSupervisor(subAgent: Agent) {
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
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
    },
  });

  return new Agent({
    id: 'supervisor',
    name: 'Supervisor',
    instructions: 'Delegate each order to the sub agent.',
    model,
    agents: { subAgent },
    memory: new Memory({
      storage: new LibSQLStore({ id: 'approval-test-mem', url: ':memory:' }),
    }),
  });
}

interface ApprovalSeen {
  toolCallId: string;
  toolName: string;
  argsText: string;
}

function collectApprovals(stream: any, approvals: ApprovalSeen[]) {
  return (async () => {
    for await (const chunk of stream.fullStream) {
      if (chunk.type === 'tool-call-approval') {
        const p: any = (chunk as any).payload ?? {};
        approvals.push({
          toolCallId: String(p.toolCallId ?? ''),
          toolName: String(p.toolName ?? ''),
          argsText: JSON.stringify(p.args ?? p.input ?? {}),
        });
      }
    }
  })();
}

let threadSeq = 0;
function memoryOpts() {
  threadSeq += 1;
  return { resource: 'rep_approval_test', thread: `t-approval-${threadSeq}` };
}

describe('parallel sub-agent delegation (suspend/resume, deterministic)', () => {
  it('emits two distinct approval requests, one per order', async () => {
    processedOrders.length = 0;
    const sub = buildSubAgent();
    const sup = buildSupervisor(sub);

    const stream = await sup.stream('Process both orders in parallel.', {
      maxSteps: 6,
      memory: memoryOpts(),
    });

    const approvals: ApprovalSeen[] = [];
    await collectApprovals(stream, approvals);

    // INVARIANT 1: both delegations raise their own approval.
    expect(approvals.length).toBe(2);
    // INVARIANT 2: the two approvals reference the two distinct orders.
    expect(approvals.some(a => a.argsText.includes(ORDER_A))).toBe(true);
    expect(approvals.some(a => a.argsText.includes(ORDER_B))).toBe(true);
    // INVARIANT 3: distinct outer tool-call ids.
    const ids = approvals.map(a => a.toolCallId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Regression guard for the parallel-approval fix (landed by @mastra/core
  // 1.48.0-alpha): approving each of two parallel approvals by toolCallId now
  // resumes both sub-agent runs independently, so BOTH orders process and
  // neither resume errors with AGENT_RESUME_NO_SNAPSHOT_FOUND. Previously
  // (<=1.42.0) the first resume tore down the second's suspended run.
  it('resuming two parallel approvals processes both orders', async () => {
    processedOrders.length = 0;
    const sub = buildSubAgent();
    const sup = buildSupervisor(sub);

    const stream = await sup.stream('Process both orders in parallel.', {
      maxSteps: 6,
      memory: memoryOpts(),
    });

    const approvals: ApprovalSeen[] = [];
    await collectApprovals(stream, approvals);
    const runId = stream.runId;

    expect(approvals.length).toBe(2);

    // Approve each pending tool call by id, one at a time, draining each
    // resumed stream and capturing resume errors.
    const resumeErrors: string[] = [];
    for (const a of approvals) {
      const resumed = await sup.approveToolCall({ runId, toolCallId: a.toolCallId });
      for await (const chunk of resumed.fullStream) {
        if (chunk.type === 'tool-error') {
          resumeErrors.push(JSON.stringify((chunk as any).payload ?? chunk));
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log('DETERMINISTIC RESUME ERRORS:', resumeErrors);
    // eslint-disable-next-line no-console
    console.log('DETERMINISTIC PROCESSED ORDERS:', processedOrders);

    // Both approvals resume cleanly and both distinct orders process.
    expect(resumeErrors).toEqual([]);
    expect(processedOrders.slice().sort()).toEqual([ORDER_A, ORDER_B].sort());
  });
});
