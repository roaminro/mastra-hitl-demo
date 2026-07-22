import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { accountAgent } from './account-agent';
import { billingAgent } from './billing-agent';
import { notificationsAgent } from './notifications-agent';
import { fulfillmentA2AAgent } from './fulfillment-a2a-agent';

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
- Delegate to the notifications-agent to email a customer (for example,
  a refund confirmation or a follow-up). Give it the customer ID (or
  email), a subject, and a body.
- Delegate shipment tracking, delivery-delay questions, and carrier
  investigations to the Fulfillment Partner. It is an external agent reached
  over A2A and owns the authoritative carrier data. First use the account-agent
  when you need to identify the customer's order ID, then give that order ID to
  the Fulfillment Partner. Only ask it to open an investigation when the rep
  explicitly requests one.
- Refunds move real money and customer emails are a real side effect, so
  the system shows the rep an Allow/Deny prompt before a refund executes
  or an email is sent. Delegating to the billing-agent or the
  notifications-agent is what triggers that prompt — never ask the rep
  for permission in text first, and never tell them to reply "Allow" or
  "Deny"; just delegate and the approval UI appears. If the rep denies an
  action, drop it and suggest alternatives the rep could offer the
  customer.

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
  agents: {
    accountAgent,
    billingAgent,
    notificationsAgent,
    fulfillmentA2AAgent,
  },
  defaultOptions: {
    maxSteps: 20,
    // Filter what the subagent sees as prior context. Otherwise the parent's
    // final user turn ("send a test email to dana") appears as a `user` message
    // in the subagent's transcript alongside the delegation prompt
    // ("Send a test email to dana@example.com. Subject: ..."), producing two
    // back-to-back user messages that make the subagent's LLM think the
    // request was never fulfilled — it re-calls the tool on the next step.
    //
    // Strip trailing user messages so the subagent sees only the delegation
    // prompt (which itself is a `user` message injected by the framework).
    delegation: {
      messageFilter: ({ messages }) => {
        const trimmed = [...messages];
        while (trimmed.length && trimmed[trimmed.length - 1]?.role === 'user') {
          trimmed.pop();
        }
        return trimmed;
      },
    },
  },
  memory: new Memory({
    options: {
      // NOTE: the token thresholds below (observation.messageTokens,
      // reflection.observationTokens) are deliberately tiny FOR DEMO PURPOSES
      // so compaction and reflection visibly trigger within a short session.
      // Production defaults are 30k message tokens / 40k observation tokens —
      // remove these overrides (or raise them) for real workloads.
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
        retrieval: {
          scope: 'thread'
        },
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
          // Whether image/file attachments are forwarded to the Observer LLM
          // (the transcript always keeps a `[Image #1: name.png]` placeholder):
          // - true   → always forward; observer can describe image contents,
          //            but requires a vision-capable observer model (default)
          // - false  → never forward; cheaper, observer only sees placeholders
          // - 'auto' → forward only if the observer model supports image input
          observeAttachments: 'auto',
        },
        reflection: {
          // Low threshold so the Reflector is demoable (default is 40k
          // observation tokens, which a demo session never reaches). Once
          // accumulated observations cross this, the Reflector condenses
          // them into a higher-level summary and generationCount increments.
          observationTokens: 2_000,
        },
      },
    },
  }),
});
