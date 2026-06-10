import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { customers, refunds } from './support-data';

export const lookupCustomerTool = createTool({
  id: 'lookup-customer',
  description: 'Look up a customer record (plan, contact info) by email or customer ID.',
  inputSchema: z.object({
    query: z.string().describe('Customer email or customer ID'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    customer: z
      .object({
        customerId: z.string(),
        name: z.string(),
        email: z.string(),
        plan: z.string(),
        since: z.string(),
      })
      .optional(),
  }),
  execute: async ({ query }) => {
    const q = query.trim().toLowerCase();
    const customer = customers.find(
      c => c.email.toLowerCase() === q || c.customerId.toLowerCase() === q,
    );
    if (!customer) return { found: false };
    const { orders, ...record } = customer;
    return { found: true, customer: record };
  },
});

export const lookupOrdersTool = createTool({
  id: 'lookup-orders',
  description: 'List all orders for a customer by customer ID, including any refunds already issued.',
  inputSchema: z.object({
    customerId: z.string(),
  }),
  outputSchema: z.object({
    orders: z.array(
      z.object({
        orderId: z.string(),
        date: z.string(),
        item: z.string(),
        amountUsd: z.number(),
        status: z.string(),
      }),
    ),
    refunds: z.array(
      z.object({
        refundId: z.string(),
        orderId: z.string(),
        amountUsd: z.number(),
        reason: z.string(),
        issuedAt: z.string(),
      }),
    ),
  }),
  execute: async ({ customerId }) => {
    const customer = customers.find(c => c.customerId === customerId);
    return {
      orders: customer?.orders ?? [],
      refunds: refunds
        .filter(r => r.customerId === customerId)
        .map(({ customerId: _, ...r }) => r),
    };
  },
});

export const issueRefundTool = createTool({
  id: 'issue-refund',
  description:
    'Issue a refund for an order. This moves real money and requires human approval.',
  inputSchema: z.object({
    orderId: z.string(),
    amountUsd: z.number().positive().describe('Refund amount in USD, up to the order amount'),
    reason: z.string().describe('Why the refund is being issued'),
  }),
  outputSchema: z.object({
    refundId: z.string(),
    orderId: z.string(),
    amountUsd: z.number(),
  }),
  requireApproval: true,
  execute: async ({ orderId, amountUsd, reason }) => {
    const customer = customers.find(c => c.orders.some(o => o.orderId === orderId));
    const order = customer?.orders.find(o => o.orderId === orderId);
    if (!customer || !order) {
      throw new Error(`Order ${orderId} not found`);
    }
    if (amountUsd > order.amountUsd) {
      throw new Error(
        `Refund amount $${amountUsd} exceeds order amount $${order.amountUsd}`,
      );
    }
    const refund = {
      refundId: `ref_${Date.now()}`,
      orderId,
      customerId: customer.customerId,
      amountUsd,
      reason,
      issuedAt: new Date().toISOString(),
    };
    refunds.push(refund);
    if (amountUsd === order.amountUsd) {
      order.status = 'refunded';
    }
    return { refundId: refund.refundId, orderId, amountUsd };
  },
});
