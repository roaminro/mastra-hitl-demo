import { A2AAgent } from '@mastra/core/a2a';
import { describe, expect, it } from 'vitest';

const cardUrl =
  process.env.FULFILLMENT_A2A_CARD_URL ??
  'http://localhost:4112/api/.well-known/fulfillment-agent/agent-card.json';

const remoteAgent = new A2AAgent({
  url: cardUrl,
  timeoutMs: 30_000,
});

describe('fulfillment A2A integration (live)', () => {
  it('discovers the remote agent through its agent card', async () => {
    const card = await remoteAgent.getAgentCard();

    expect(card.name).toBe('fulfillment-agent');
    expect(card.description).toContain('external logistics partner');
    expect(card.url).toBe(new URL('/api/a2a/fulfillment-agent', cardUrl).toString());
    expect(card.capabilities.streaming).toBe(true);
  });

  it('streams a remote task and returns its final artifact', async () => {
    const result = await remoteAgent.generate(
      'Track shipment ord_1003. Include the carrier, status, delay reason, and estimated delivery.',
    );

    expect(result.task?.status.state).toBe('completed');
    expect(result.task?.id).toBeTruthy();
    expect(result.text).toContain('ParcelFox');
    expect(result.text).toContain('Weather');
    expect(result.text).toContain('2026-07-17');
  }, 60_000);
});
