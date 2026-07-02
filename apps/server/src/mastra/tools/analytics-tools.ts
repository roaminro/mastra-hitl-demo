import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyticsAccounts, analyticsTransactions } from './analytics-data';

// Mock analytics tools for the code mode demo. They intentionally return
// LARGE list payloads (hundreds of rows) with no server-side aggregation —
// the point is that code mode's generated function must join, filter, and
// reduce these lists in the sandbox instead of dumping them into the
// agent's context window.

export const listTransactionsTool = createTool({
  id: 'list-transactions',
  description:
    'List billing transactions for 2026. Returns EVERY matching transaction as a raw list (500 rows unfiltered) — there is no aggregation option. Optionally filter by month (1-12) or status.',
  inputSchema: z.object({
    month: z.number().int().min(1).max(12).optional().describe('Calendar month of 2026 to filter by'),
    status: z.enum(['paid', 'refunded', 'failed']).optional(),
  }),
  outputSchema: z.object({
    transactions: z.array(
      z.object({
        txnId: z.string(),
        customerId: z.string(),
        amountCents: z.number(),
        category: z.enum(['subscription', 'usage', 'addon', 'services']),
        status: z.enum(['paid', 'refunded', 'failed']),
        date: z.string(),
      }),
    ),
    count: z.number(),
  }),
  execute: async ({ month, status }) => {
    let rows = analyticsTransactions;
    if (month !== undefined) {
      const mm = String(month).padStart(2, '0');
      rows = rows.filter(t => t.date.startsWith(`2026-${mm}-`));
    }
    if (status) rows = rows.filter(t => t.status === status);
    return { transactions: rows, count: rows.length };
  },
});

export const listAccountsTool = createTool({
  id: 'list-accounts',
  description:
    'List all customer accounts with region and plan. Returns the full raw list (40 rows) — no filtering or grouping.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    accounts: z.array(
      z.object({
        customerId: z.string(),
        name: z.string(),
        region: z.enum(['na', 'emea', 'apac', 'latam']),
        plan: z.enum(['free', 'pro', 'enterprise']),
        signupDate: z.string(),
      }),
    ),
    count: z.number(),
  }),
  execute: async () => ({
    accounts: analyticsAccounts,
    count: analyticsAccounts.length,
  }),
});

export const getAccountTransactionsTool = createTool({
  id: 'get-account-transactions',
  description:
    'Get every transaction for one account (raw list, no aggregation). Useful for per-account fan-out.',
  inputSchema: z.object({
    customerId: z.string(),
  }),
  outputSchema: z.object({
    customerId: z.string(),
    transactions: z.array(
      z.object({
        txnId: z.string(),
        amountCents: z.number(),
        category: z.enum(['subscription', 'usage', 'addon', 'services']),
        status: z.enum(['paid', 'refunded', 'failed']),
        date: z.string(),
      }),
    ),
    count: z.number(),
  }),
  execute: async ({ customerId }) => {
    const rows = analyticsTransactions
      .filter(t => t.customerId === customerId)
      .map(({ customerId: _cid, ...rest }) => rest);
    return { customerId, transactions: rows, count: rows.length };
  },
});
