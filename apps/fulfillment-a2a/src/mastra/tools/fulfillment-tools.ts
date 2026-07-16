import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { investigations, shipments } from './shipment-data';

export const trackShipmentTool = createTool({
  id: 'track-shipment',
  description:
    'Look up a shipment by order ID. Returns its carrier, tracking number, delivery estimate, delay reason, and scan history.',
  inputSchema: z.object({
    orderId: z.string().describe('The merchant order ID, for example ord_1003'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    shipment: z
      .object({
        orderId: z.string(),
        trackingNumber: z.string(),
        carrier: z.string(),
        status: z.enum(['in_transit', 'delayed', 'delivered']),
        estimatedDelivery: z.string(),
        delayReason: z.string().optional(),
        events: z.array(
          z.object({
            at: z.string(),
            location: z.string(),
            description: z.string(),
          }),
        ),
      })
      .optional(),
  }),
  execute: async ({ orderId }) => {
    const shipment = shipments.find(item => item.orderId === orderId);
    return shipment ? { found: true, shipment } : { found: false };
  },
});

export const openCarrierInvestigationTool = createTool({
  id: 'open-carrier-investigation',
  description:
    'Open a carrier investigation for a delayed shipment. Returns the carrier case reference and next-update deadline.',
  inputSchema: z.object({
    orderId: z.string(),
    reason: z.string().describe('Short reason for opening the investigation'),
  }),
  outputSchema: z.object({
    opened: z.boolean(),
    caseId: z.string().optional(),
    orderId: z.string(),
    carrier: z.string().optional(),
    status: z.enum(['investigating']).optional(),
    openedAt: z.string().optional(),
    nextUpdateBy: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ orderId }) => {
    const shipment = shipments.find(item => item.orderId === orderId);
    if (!shipment) {
      return { opened: false, orderId, error: 'Shipment not found' };
    }

    const existing = investigations.get(orderId);
    if (existing) {
      return {
        opened: true,
        ...existing,
        carrier: shipment.carrier,
        status: 'investigating' as const,
      };
    }

    const investigation = {
      caseId: `case_${shipment.trackingNumber.slice(-6)}`,
      orderId,
      openedAt: '2026-07-14T14:00:00Z',
      nextUpdateBy: '2026-07-16T17:00:00Z',
    };
    investigations.set(orderId, investigation);

    return {
      opened: true,
      ...investigation,
      carrier: shipment.carrier,
      status: 'investigating' as const,
    };
  },
});
