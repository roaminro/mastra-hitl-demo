import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { billingAgent } from '../agents/billing-agent';
import { accountAgent } from '../agents/account-agent';
import { refunds, customers } from '../tools/support-data';

/**
 * Observational Memory (OM) compaction robustness under delegation + approval.
 *
 * The support copilot runs OM on a long-lived rep thread. These tests confirm
 * the Observer ("compaction") fires correctly even when the conversation is
 * interleaved with sub-agent delegations and an approval suspension — the two
 * places where OM could plausibly mis-handle the message stream.
 *
 * We detect compaction deterministically via the OM `onDebugEvent` hook
 * (`observation_triggered` / `observation_complete`), not by guessing from
 * token counts. A low `messageTokens` threshold makes the Observer fire within
 * a handful of turns.
 *
 * Skips without OPENROUTER_API_KEY (the Observer uses a real model).
 */

const hasKey = !!process.env.OPENROUTER_API_KEY;
const d = hasKey ? describe : describe.skip;

function buildSupervisor() {
  return new Agent({
    id: 'om-test-supervisor',
    name: 'OM Test Supervisor',
    description: 'Support copilot used to exercise OM compaction under delegation.',
    instructions: `You are a support copilot for an internal rep. Delegate
account lookups to the account-agent and refunds to the billing-agent. Pass the
order ID, amount, and reason for refunds. Be concise.`,
    model: 'openrouter/openai/gpt-5.4-mini',
    agents: { accountAgent, billingAgent },
    memory: new Memory({
      storage: new LibSQLStore({ id: 'om-test-store', url: ':memory:' }),
      options: {
        observationalMemory: {
          model: 'openrouter/google/gemini-2.5-flash',
          // Very low threshold so the Observer fires within a few turns.
          observation: {
            messageTokens: 400,
            // Synchronous so the observation completes within the turn that
            // crosses the threshold (no waiting on background buffering).
            bufferTokens: false,
          },
        },
      },
    }),
  });
}

/**
 * OM compaction surfaces on the agent stream as `data-om-*` parts. We separate
 * the per-turn token bookkeeping (`data-om-status`) from the events that mean
 * the Observer actually ran / observations were activated.
 */
const isOmChunk = (type: string): boolean => type.includes('-om-') || type.startsWith('data-om');

// Events that indicate real compaction work, not just status bookkeeping.
const isOmCompactionChunk = (type: string): boolean =>
  type.includes('om-observation-start') ||
  type.includes('om-observation-end') ||
  type.includes('om-activation') ||
  type.includes('om-buffering-start') ||
  type.includes('om-buffering-end');

function freshLedger(orderId: string) {
  refunds.length = 0;
  for (const c of customers)
    for (const o of c.orders) if (o.orderId === orderId) o.status = 'delivered';
}

d('OM compaction under delegation + approval (REAL LLM)', () => {
  it('Observer fires across delegating turns without breaking the conversation', async () => {
    const sup = buildSupervisor();
    const mem = { resource: 'rep_om_test', thread: `om-${Date.now()}` };

    // Several delegating turns to accumulate observed tokens past the threshold.
    // Each turn delegates (account/billing) and asks for detail, so observed
    // message tokens climb quickly past the 400-token threshold.
    const turns = [
      'List all customers in the CRM with their plans.',
      "Look up dana@example.com — give me her full plan details and every order with amounts and statuses.",
      'Now sam@example.com — full plan details and every order with amounts and statuses.',
      'Compare the two customers in detail: tenure, plan, total spend, and order history.',
      'Give me a thorough recap of everything we have discussed about both customers.',
    ];

    const omChunkTypes: Record<string, number> = {};
    let lastReply = '';
    for (const text of turns) {
      const stream = await sup.stream(text, { maxSteps: 8, memory: mem });
      // Drain the stream so the turn (and any synchronous observation) finishes.
      for await (const chunk of stream.fullStream) {
        if (isOmChunk(chunk.type)) {
          omChunkTypes[chunk.type] = (omChunkTypes[chunk.type] ?? 0) + 1;
        }
      }
      lastReply = await stream.text;
    }

    // eslint-disable-next-line no-console
    console.log('OM chunk types:', JSON.stringify(omChunkTypes, null, 2));

    // Real compaction (Observer ran / observations activated) must have fired —
    // not merely the per-turn `data-om-status` bookkeeping.
    const compactionCount = Object.entries(omChunkTypes)
      .filter(([type]) => isOmCompactionChunk(type))
      .reduce((sum, [, n]) => sum + n, 0);
    expect(compactionCount).toBeGreaterThanOrEqual(1);
    // The conversation still produced a coherent final reply (compaction did
    // not break the turn it fired on).
    expect(lastReply.length).toBeGreaterThan(0);
  });

  it('Observer fires correctly even when a turn suspends for approval', async () => {
    const orderId = 'ord_2001';
    freshLedger(orderId);
    const sup = buildSupervisor();
    const mem = { resource: 'rep_om_test2', thread: `om-sus-${Date.now()}` };

    const omChunkTypes: Record<string, number> = {};
    const collectOm = async (stream: { fullStream: AsyncIterable<{ type: string }> }) => {
      for await (const chunk of stream.fullStream) {
        if (isOmChunk(chunk.type)) {
          omChunkTypes[chunk.type] = (omChunkTypes[chunk.type] ?? 0) + 1;
        }
      }
    };

    // Pre-load the thread with enough context to be near the threshold.
    for (const text of [
      'List all customers in the CRM.',
      "What plan is sam@example.com on, and what are his recent orders?",
    ]) {
      const stream = await sup.stream(text, { maxSteps: 8, memory: mem });
      await collectOm(stream);
    }

    // Now a refund turn that suspends for approval (billing -> issue-refund).
    const refundStream = await sup.stream(
      `Refund order ${orderId} for customer cust_002, amount 900 USD, reason: duplicate charge. Proceed now.`,
      { maxSteps: 10, memory: mem },
    );
    let pendingToolCallId = '';
    for await (const chunk of refundStream.fullStream) {
      if (isOmChunk(chunk.type)) {
        omChunkTypes[chunk.type] = (omChunkTypes[chunk.type] ?? 0) + 1;
      }
      if (chunk.type === 'tool-call-approval') {
        const p: any = (chunk as any).payload ?? {};
        if (p.toolCallId) pendingToolCallId = String(p.toolCallId);
      }
    }
    const runId = refundStream.runId;
    expect(pendingToolCallId).toBeTruthy();

    // Approve and drain — the conversation must continue cleanly post-resume.
    const resumed = await sup.approveToolCall({ runId, toolCallId: pendingToolCallId });
    await collectOm(resumed);

    // One more turn after resume; OM should keep working through suspend/resume.
    const after = await sup.stream('Give me a one-line summary of what we just did.', {
      maxSteps: 8,
      memory: mem,
    });
    await collectOm(after);

    // eslint-disable-next-line no-console
    console.log('OM chunk types (with approval):', JSON.stringify(omChunkTypes, null, 2));
    // eslint-disable-next-line no-console
    console.log('refund executed:', refunds.map((r) => r.orderId));

    // The refund went through (approval path intact under OM).
    expect(refunds.some((r) => r.orderId === orderId)).toBe(true);
    // Real compaction fired across the suspend/resume conversation — and the
    // refund still executed, proving OM didn't corrupt the approval flow.
    const compactionCount = Object.entries(omChunkTypes)
      .filter(([type]) => isOmCompactionChunk(type))
      .reduce((sum, [, n]) => sum + n, 0);
    expect(compactionCount).toBeGreaterThanOrEqual(1);
  });
});
