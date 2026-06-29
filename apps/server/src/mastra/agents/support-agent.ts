import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { accountAgent } from './account-agent';
import { billingAgent } from './billing-agent';

export const supportAgent = new Agent({
  id: 'support-agent',
  name: 'Support',
  description:
    'Support copilot for internal support reps. Coordinates account lookups and billing actions on behalf of the rep, and remembers customers across tickets.',
  instructions: `You are a support copilot assisting an internal support rep.
The person you are chatting with is a support rep handling customer
tickets — not the customer. Address them as a colleague.

Use your team for the actual work:
- Delegate to the account-agent to list all customers in the CRM, or to
  look up a customer and fetch their plan, orders, and refund history.
- Delegate to the billing-agent for refunds. Pass the order ID, exact
  amount, and reason. If the rep hasn't given a reason, ask once; if they
  tell you to proceed without one, use "customer requested refund".
  Refunds always go to the original payment method — don't ask.
- Once the rep has identified the order and asked for the refund,
  delegate to the billing-agent immediately. Do not re-ask for details
  they already gave.
- Refunds move real money, so the system shows the rep an Allow/Deny
  prompt before the refund executes. Delegating to the billing-agent is
  what triggers that prompt — never ask the rep for permission in text
  first, and never tell them to reply "Allow" or "Deny"; just delegate
  and the approval UI appears. If the rep denies a refund, drop it and
  suggest alternatives the rep could offer the customer.

Report only what your tools and teammates actually return — never invent
IDs, approvers, or timestamps. Use what you remember from previous
tickets: reference customers the rep has handled before and don't re-ask
for information you already have. Be concise and factual, like a good
internal tool.

Your memory is summarized over time, so older details (full ticket
histories, exact order IDs, amounts, dates, and prior wording) may have
been compacted out of what you can see directly. You have a "recall" tool
that pages back to the original, un-summarized messages. When a rep asks
for an EXACT or verbatim value — a specific ID, amount, date, or the
precise wording of something said earlier — and it isn't already in front
of you, use the recall tool to retrieve the source rather than answering
from your summary. Never paraphrase a value the rep asked for exactly, and
never claim a detail is unavailable before checking recall.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  agents: { accountAgent, billingAgent },
  defaultOptions: {
    maxSteps: 20
  },
  memory: new Memory({
    options: {
      observationalMemory: {
        model: 'openrouter/google/gemini-2.5-flash',
        // Cross-conversation memory: observations are shared across all
        // threads for a resource (one resource per customer).
        // scope: 'resource',
        // Anchor observations in time ("customer returned after 2 days").
        temporalMarkers: true,
        // Retrieval mode (experimental): keep each observation group linked
        // to the raw messages it was compressed from, and register a `recall`
        // tool so the agent can page back to exact wording / tool output when
        // the summary dropped it. This means a large tool result (e.g. a full
        // account history) can trigger compaction WITHOUT permanently losing
        // the verbatim IDs and amounts a support rep depends on.
        retrieval: true,
        observation: {
          // Low threshold so the Observer visibly kicks in during a demo
          // (default is 30k tokens). One `fetch-account-history` pull is
          // enough to cross this and trigger compaction + activation.
          messageTokens: 3_000,
          // Async buffering: observe in the background every 25% of the
          // threshold so activation is instant instead of a blocking call.
          bufferTokens: 0.25,
          // Keep less raw history after activation so the eviction (and the
          // resulting "Memory activated" event) is clearly visible in a demo.
          bufferActivation: 0.5,
        },
      },
    },
  }),
});
