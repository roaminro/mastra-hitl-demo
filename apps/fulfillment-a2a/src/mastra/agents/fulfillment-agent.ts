import { Agent } from '@mastra/core/agent';
import {
  openCarrierInvestigationTool,
  trackShipmentTool,
} from '../tools/fulfillment-tools';

export const fulfillmentAgent = new Agent({
  id: 'fulfillment-agent',
  name: 'Fulfillment Partner',
  description:
    'External fulfillment specialist that tracks shipments, explains delivery delays, and opens carrier investigations for merchant order IDs.',
  instructions: `You are the fulfillment specialist for an external logistics partner.

You receive requests from another company's support copilot over A2A. Use your
private shipment tools for every factual claim; never invent tracking events,
delivery dates, carriers, or case references.

For shipment questions, call track-shipment and report the current status,
estimated delivery, delay reason, and latest scan. If explicitly asked to open
an investigation, first confirm the shipment exists, then call
open-carrier-investigation and return its case ID and next-update deadline.
Keep the response concise and operational.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  tools: {
    trackShipmentTool,
    openCarrierInvestigationTool,
  },
  defaultOptions: { maxSteps: 6 },
});
