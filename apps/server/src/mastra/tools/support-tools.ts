import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { customers, refunds } from './support-data';

export const listCustomersTool = createTool({
  id: 'list-customers',
  description:
    'List all customers in the CRM with their ID, name, email, and plan.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    customers: z.array(
      z.object({
        customerId: z.string(),
        name: z.string(),
        email: z.string(),
        plan: z.string(),
      }),
    ),
  }),
  execute: async () => ({
    customers: customers.map(({ customerId, name, email, plan }) => ({
      customerId,
      name,
      email,
      plan,
    })),
  }),
});

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

export const riskCheckTool = createTool({
  id: 'risk-check',
  description:
    'Assess the fraud/abuse risk of refunding a specific order. Read-only: returns a risk level and notes based on the order amount and the customer refund history.',
  inputSchema: z.object({
    orderId: z.string(),
    amountUsd: z.number().positive(),
  }),
  outputSchema: z.object({
    orderId: z.string(),
    riskLevel: z.enum(['low', 'medium', 'high']),
    score: z.number(),
    notes: z.array(z.string()),
  }),
  execute: async ({ orderId, amountUsd }) => {
    const customer = customers.find(c => c.orders.some(o => o.orderId === orderId));
    const order = customer?.orders.find(o => o.orderId === orderId);
    const notes: string[] = [];
    let score = 0;

    if (!customer || !order) {
      return {
        orderId,
        riskLevel: 'high' as const,
        score: 100,
        notes: ['Order not found in CRM — cannot verify.'],
      };
    }

    // Large refunds are riskier.
    if (amountUsd >= 1000) {
      score += 50;
      notes.push(`High refund amount ($${amountUsd}).`);
    } else if (amountUsd >= 500) {
      score += 25;
      notes.push(`Moderate refund amount ($${amountUsd}).`);
    } else {
      notes.push(`Low refund amount ($${amountUsd}).`);
    }

    // Repeat refunders are riskier.
    const priorRefunds = refunds.filter(r => r.customerId === customer.customerId).length;
    if (priorRefunds >= 2) {
      score += 40;
      notes.push(`Customer has ${priorRefunds} prior refunds.`);
    } else if (priorRefunds === 1) {
      score += 15;
      notes.push('Customer has 1 prior refund.');
    } else {
      notes.push('No prior refunds on record.');
    }

    // Long-tenured customers are lower risk.
    const tenureYears =
      (Date.now() - new Date(customer.since).getTime()) / (1000 * 60 * 60 * 24 * 365);
    if (tenureYears >= 1) {
      score = Math.max(0, score - 15);
      notes.push(`Established customer (since ${customer.since}).`);
    }

    const riskLevel: 'low' | 'medium' | 'high' =
      score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low';
    return { orderId, riskLevel, score, notes };
  },
});

export const fetchAccountHistoryTool = createTool({
  id: 'fetch-account-history',
  description:
    'Fetch the full support interaction history for a customer: every past ticket, agent notes, and resolution. Returns a large, detailed record — use it when the rep needs full context on a customer before acting.',
  inputSchema: z.object({
    customerId: z.string(),
  }),
  outputSchema: z.object({
    customerId: z.string(),
    customerName: z.string(),
    ticketCount: z.number(),
    tickets: z.array(
      z.object({
        ticketId: z.string(),
        openedAt: z.string(),
        closedAt: z.string(),
        channel: z.string(),
        category: z.string(),
        subject: z.string(),
        summary: z.string(),
        agentNotes: z.string(),
        resolution: z.string(),
        satisfaction: z.number(),
      }),
    ),
  }),
  execute: async ({ customerId }) => {
    const customer = customers.find(c => c.customerId === customerId);
    if (!customer) {
      return { customerId, customerName: 'Unknown', ticketCount: 0, tickets: [] };
    }

    // Generate a sizable, realistic ticket history. This is intentionally
    // verbose: a single call returns several KB of detail so a turn crosses
    // the Observational Memory threshold and the Observer compacts it. With
    // retrieval mode enabled, the exact ticket IDs / dates remain recallable.
    const channels = ['email', 'chat', 'phone', 'in-app'];
    const categories = [
      'billing question',
      'feature request',
      'bug report',
      'onboarding help',
      'account access',
      'plan upgrade',
    ];
    const tickets = Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      const opened = new Date(
        new Date(customer.since).getTime() + n * 18 * 24 * 60 * 60 * 1000,
      );
      const closed = new Date(opened.getTime() + (1 + (n % 4)) * 24 * 60 * 60 * 1000);
      const category = categories[i % categories.length];
      const channel = channels[i % channels.length];
      return {
        ticketId: `tkt_${customer.customerId.split('_')[1]}_${String(n).padStart(3, '0')}`,
        openedAt: opened.toISOString(),
        closedAt: closed.toISOString(),
        channel,
        category,
        subject: `[${category}] ${customer.name} — ticket #${n}`,
        summary:
          `${customer.name} reached out via ${channel} regarding a ${category}. ` +
          `The customer described their situation in detail and the rep gathered ` +
          `account context, reviewed recent orders, and confirmed the customer's ` +
          `plan (${customer.plan}). The interaction required cross-checking the ` +
          `billing system and the order ledger before a path forward was agreed.`,
        agentNotes:
          `Verified identity against email ${customer.email} and customer ID ` +
          `${customer.customerId}. Reviewed order history; no anomalies flagged ` +
          `on this ticket. Customer tone was cooperative. Escalation was ` +
          `${n % 5 === 0 ? 'required to tier-2 billing' : 'not necessary'}. ` +
          `Documented the exact figures discussed and the agreed next steps so ` +
          `future reps have a complete trail.`,
        resolution:
          n % 3 === 0
            ? 'Resolved with a one-time courtesy credit applied to the account.'
            : n % 3 === 1
              ? 'Resolved by walking the customer through the relevant settings.'
              : 'Resolved after engineering confirmed the underlying issue was fixed.',
        satisfaction: 3 + (n % 3),
      };
    });

    return {
      customerId,
      customerName: customer.name,
      ticketCount: tickets.length,
      tickets,
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
