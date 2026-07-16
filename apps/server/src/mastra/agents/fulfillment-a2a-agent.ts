import { A2AAgent } from '@mastra/core/a2a';

export const fulfillmentA2AAgent = new A2AAgent({
  id: 'fulfillment-a2a-agent',
  name: 'Fulfillment Partner',
  description:
    'External A2A fulfillment specialist. Tracks shipments, explains delivery delays, and opens carrier investigations for merchant order IDs.',
  url:
    process.env.FULFILLMENT_A2A_CARD_URL ??
    'http://localhost:4112/api/.well-known/fulfillment-agent/agent-card.json',
  retries: 2,
  backoffMs: 250,
  maxBackoffMs: 1_000,
  timeoutMs: 30_000,
});
