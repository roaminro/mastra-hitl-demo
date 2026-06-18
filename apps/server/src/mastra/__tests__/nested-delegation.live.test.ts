import { describe, it, expect } from 'vitest';
import { mastra } from '../index';

/**
 * Confirms the real demo now has a multi-level delegation chain:
 *   support-agent -> billing-agent -> risk-agent
 *
 * The UI's nested rendering (subagent-activity.tsx `collectNestedAgents`)
 * relies on the child delegation surfacing as an `agent-*` tool-call/result
 * pair INSIDE the parent (billing) subagent's buffered output — verified by
 * nested-delegation.probe.test.ts. Here we assert that billing actually
 * delegates to risk during a refund, so the nested card has something to show.
 *
 * Skips without OPENROUTER_API_KEY.
 */

const hasKey = !!process.env.OPENROUTER_API_KEY;
const d = hasKey ? describe : describe.skip;

d('multi-level delegation in the support demo (REAL LLM)', () => {
  it('billing delegates to risk-agent during a refund (nested agent-* call appears)', async () => {
    const supportAgent = mastra.getAgentById('support-agent');
    const stream = await supportAgent.stream(
      'Refund order ord_2003 for customer cust_002, amount 1500 USD, reason: cancelled workshop. Proceed now.',
      {
        maxSteps: 12,
        memory: { resource: 'rep_nested_test', thread: `nested-${Date.now()}` },
      },
    );

    const agentToolNames = new Set<string>();
    const scan = (obj: any, depth = 0) => {
      if (!obj || depth > 8) return;
      if (Array.isArray(obj)) {
        for (const v of obj) scan(v, depth + 1);
        return;
      }
      if (typeof obj === 'object') {
        if (typeof obj.toolName === 'string' && obj.toolName.startsWith('agent-')) {
          agentToolNames.add(obj.toolName);
        }
        for (const v of Object.values(obj)) scan(v, depth + 1);
      }
    };

    for await (const chunk of stream.fullStream) {
      // Top-level delegation (support -> billing) surfaces as a tool-call on
      // the supervisor stream.
      if (chunk.type === 'tool-call') {
        const tn = (chunk as any).payload?.toolName ?? (chunk as any).toolName;
        if (typeof tn === 'string' && tn.startsWith('agent-')) agentToolNames.add(tn);
      }
      // The nested delegation (billing -> risk) happens BEFORE issue-refund
      // (billing checks risk first), so it's already inside billing's buffered
      // AGENT output by the time the approval surfaces. Scan those outputs.
      if (chunk.type === 'tool-output') {
        const out: any = (chunk as any).payload?.output ?? (chunk as any).output;
        if (out?.from === 'AGENT') scan(out.payload ?? out);
      }
    }

    // eslint-disable-next-line no-console
    console.log('NESTED LIVE agent-* tool names seen:', [...agentToolNames]);

    // billing-agent is delegated to by support (agent-billingAgent), and
    // risk-agent is delegated to by billing (agent-riskAgent, nested).
    expect([...agentToolNames].some((n) => /billing/i.test(n))).toBe(true);
    expect([...agentToolNames].some((n) => /risk/i.test(n))).toBe(true);
  });
});
