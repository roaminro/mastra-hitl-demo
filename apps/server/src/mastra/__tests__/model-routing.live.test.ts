import { describe, it, expect } from 'vitest';
import { routingAgent } from '../agents/routing-agent';

/**
 * REAL-LLM test for the model routing demo.
 *
 * Streams two contrasting prompts through the routing-agent and asserts that
 * the ModelRoutingProcessor (a) emits a visible `data-model-routing` chunk,
 * and (b) routes a trivial greeting to the cheap tier and a multi-step coding
 * request to the strong tier.
 *
 * Skips automatically when OPENROUTER_API_KEY is absent.
 */

const hasKey = !!process.env.OPENROUTER_API_KEY;
const d = hasKey ? describe : describe.skip;

interface RoutingDecision {
  label: string;
  model: string;
  tier: 'cheap' | 'strong';
  reason: string;
  classifierMs: number;
}

async function runAndCaptureDecision(prompt: string) {
  const stream = await routingAgent.stream(prompt);
  let decision: RoutingDecision | undefined;
  for await (const chunk of stream.fullStream) {
    if ((chunk as { type?: string }).type === 'data-model-routing') {
      decision = (chunk as unknown as { data: RoutingDecision }).data;
    }
  }
  return { decision, text: await stream.text };
}

d('model routing demo (live)', () => {
  it('routes a trivial greeting to the cheap tier', async () => {
    const { decision, text } = await runAndCaptureDecision(
      "hey, how's it going?",
    );

    expect(decision).toBeDefined();
    expect(decision!.tier).toBe('cheap');
    expect(decision!.model).toContain('mini');
    expect(text.length).toBeGreaterThan(0);
  });

  it('routes a multi-step coding request to the strong tier', async () => {
    const { decision, text } = await runAndCaptureDecision(
      'Write a TypeScript function that balances a red-black tree after ' +
        'insertion, and explain the invariants each rotation preserves.',
    );

    expect(decision).toBeDefined();
    expect(decision!.tier).toBe('strong');
    expect(decision!.model).not.toContain('mini');
    expect(text.length).toBeGreaterThan(0);
  });
});
