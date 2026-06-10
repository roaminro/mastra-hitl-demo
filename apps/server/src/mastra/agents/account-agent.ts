import { Agent } from '@mastra/core/agent';
import { lookupCustomerTool, lookupOrdersTool } from '../tools/support-tools';

export const accountAgent = new Agent({
  id: 'account-agent',
  name: 'Account Specialist',
  description:
    'Looks up customer records and order history. Read-only: use this to identify a customer and fetch their plan, orders, and past refunds.',
  instructions: `You are an account specialist on a customer support team.

Given a customer email or ID, look up their record and order history using
your tools. Report findings concisely and factually: plan, tenure, orders
with statuses and amounts, and any past refunds. Do not make promises or
decisions about refunds or account changes — that is not your job.`,
  model: 'openrouter/openai/gpt-5-mini',
  tools: { lookupCustomerTool, lookupOrdersTool },
});
