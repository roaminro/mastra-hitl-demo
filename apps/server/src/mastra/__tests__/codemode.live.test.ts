import { describe, it, expect } from 'vitest';
import { codemodeAgent } from '../agents/codemode-agent';
import {
  analyticsAccounts,
  analyticsTransactions,
} from '../tools/analytics-data';

/**
 * REAL-LLM test for the code mode demo.
 *
 * The analytics dataset is deterministic (seeded PRNG), so the test computes
 * the expected aggregates in plain TypeScript and asserts the agent's
 * sandbox-generated code produced the exact same numbers. This proves code
 * mode actually aggregates large tool results in code (correct math, small
 * result) instead of token-predicting over raw lists.
 *
 * Skips automatically when OPENROUTER_API_KEY is absent.
 */

const hasKey = !!process.env.OPENROUTER_API_KEY;
const d = hasKey ? describe : describe.skip;

interface CapturedRun {
  text: string;
  /** normalized text: lowercase, commas/spaces stripped from numbers */
  normalized: string;
  codeCalls: string[];
  toolResults: unknown[];
}

async function runAndCapture(prompt: string): Promise<CapturedRun> {
  const stream = await codemodeAgent.stream(prompt);
  const codeCalls: string[] = [];
  const toolResults: unknown[] = [];

  for await (const chunk of stream.fullStream) {
    const c = chunk as { type?: string; payload?: Record<string, unknown> };
    if (c.type === 'tool-call' && c.payload?.toolName === 'execute_typescript') {
      const args = c.payload.args as { code?: string } | undefined;
      if (args?.code) codeCalls.push(args.code);
    }
    if (c.type === 'tool-result' && c.payload?.toolName === 'execute_typescript') {
      toolResults.push(c.payload.result);
    }
  }

  const text = await stream.text;
  return {
    text,
    normalized: text.toLowerCase().replace(/[,\s]/g, ''),
    codeCalls,
    toolResults,
  };
}

// --- expected aggregates computed from the deterministic dataset ---

const regionOf = new Map(analyticsAccounts.map(a => [a.customerId, a.region]));

const marchPaid = analyticsTransactions.filter(
  t => t.status === 'paid' && t.date.startsWith('2026-03-'),
);
const marchPaidTotalCents = marchPaid.reduce((s, t) => s + t.amountCents, 0);
const marchByRegion = new Map<string, number>();
for (const t of marchPaid) {
  const region = regionOf.get(t.customerId)!;
  marchByRegion.set(region, (marchByRegion.get(region) ?? 0) + t.amountCents);
}
const topMarchRegion = [...marchByRegion.entries()].sort((a, b) => b[1] - a[1])[0]!;

const paidByAccount = new Map<string, number>();
for (const t of analyticsTransactions) {
  if (t.status !== 'paid') continue;
  paidByAccount.set(
    t.customerId,
    (paidByAccount.get(t.customerId) ?? 0) + t.amountCents,
  );
}
const topAccountId = [...paidByAccount.entries()].sort((a, b) => b[1] - a[1])[0]![0];
const topAccountName = analyticsAccounts.find(
  a => a.customerId === topAccountId,
)!.name;

d('code mode demo (live)', () => {
  it('aggregates 500 raw transactions in sandbox code with exact math', async () => {
    const run = await runAndCapture(
      'For March 2026: report the exact total PAID revenue in cents as a ' +
        'plain integer, the paid revenue in cents per region as plain ' +
        'integers, and which region ranks highest.',
    );

    // The model wrote code that calls the bridged tools and aggregates.
    expect(run.codeCalls.length).toBeGreaterThan(0);
    const code = run.codeCalls.join('\n');
    expect(code).toContain('external_list_transactions');
    expect(code).toMatch(/reduce|for\s*\(|forEach|\+=/);

    // The tool result returned to the agent is a small aggregate, not the
    // raw 500-row list (~60KB serialized).
    const rawSize = JSON.stringify(analyticsTransactions).length;
    const resultSize = JSON.stringify(run.toolResults).length;
    expect(resultSize).toBeLessThan(rawSize / 5);

    // Exact math: totals computed in the sandbox match totals computed here
    // from the same deterministic dataset.
    expect(run.normalized).toContain(String(marchPaidTotalCents));
    expect(run.normalized).toContain(String(topMarchRegion[1]));
    expect(run.normalized).toContain(topMarchRegion[0]);
  }, 180_000);

  it('joins accounts with transactions to rank top accounts by paid revenue', async () => {
    const run = await runAndCapture(
      'Across all of 2026, which single account generated the most PAID ' +
        'revenue? Give the account name and its exact paid total in cents ' +
        'as a plain integer.',
    );

    expect(run.codeCalls.length).toBeGreaterThan(0);

    expect(run.normalized).toContain(topAccountName.toLowerCase().replace(/\s/g, ''));
    expect(run.normalized).toContain(String(paidByAccount.get(topAccountId)!));
  }, 180_000);
});
