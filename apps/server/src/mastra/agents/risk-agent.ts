import { Agent } from '@mastra/core/agent';
import { riskCheckTool } from '../tools/support-tools';

/**
 * Nested (tier-2) subagent: the billing-agent delegates to this risk
 * specialist before issuing a refund, creating a multi-level delegation
 * chain (support -> billing -> risk). Read-only; it never moves money.
 */
export const riskAgent = new Agent({
  id: 'risk-agent',
  name: 'Risk Analyst',
  description:
    'Assesses fraud/abuse risk for a proposed refund. Read-only: returns a risk level (low/medium/high) and notes. Does not issue refunds.',
  instructions: `You are a risk analyst on a customer support team.

When asked to assess a refund, use the risk-check tool with the order ID and
amount, then report the risk level (low, medium, or high) and a one-line
justification drawn from the tool's notes. Be concise and factual. You never
issue refunds or make the final call — you only advise.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  tools: { riskCheckTool },
});
