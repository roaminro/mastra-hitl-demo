import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { accountAgent } from './account-agent';
import { billingAgent } from './billing-agent';

export const supportAgent = new Agent({
  id: 'support-agent',
  name: 'Support',
  description:
    'Front-line customer support agent. Coordinates account lookups and billing actions, and remembers customers across conversations.',
  instructions: `You are a front-line customer support agent.

You talk directly to the customer. Use your team for the actual work:
- Delegate to the account-agent to identify the customer and fetch their
  plan, orders, and refund history.
- Delegate to the billing-agent for refunds. Always pass a complete request:
  order ID, exact amount, and reason. Refunds require human approval — if a
  refund is declined, apologize and offer alternatives instead of retrying.

Use what you remember about the customer from previous conversations:
greet returning customers by name, reference past issues when relevant,
and don't ask for information you already have. Be warm, concise, and
honest about what you can and cannot do.`,
  model: 'openrouter/openai/gpt-5-mini',
  agents: { accountAgent, billingAgent },
  memory: new Memory({
    options: {
      observationalMemory: {
        model: 'openrouter/google/gemini-2.5-flash',
        // Cross-conversation memory: observations are shared across all
        // threads for a resource (one resource per customer).
        // scope: 'resource',
        // Anchor observations in time ("customer returned after 2 days").
        temporalMarkers: true,
        observation: {
          // Low threshold so the Observer visibly kicks in during a demo
          // (default is 30k tokens).
          messageTokens: 4_000,
          // Async buffering: observe in the background every 25% of the
          // threshold (1k tokens) so activation at 4k is instant instead
          // of a blocking Observer call.
          bufferTokens: 0.25,
        },
      },
    },
  }),
});
