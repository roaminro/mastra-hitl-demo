import { Agent } from '@mastra/core/agent';
import {
  listCustomersTool,
  lookupCustomerTool,
  lookupOrdersTool,
} from '../tools/support-tools';

export const accountAgent = new Agent({
  id: 'account-agent',
  name: 'Account Specialist',
  description:
    'Looks up customer records and order history. Read-only: use this to list all customers, identify a customer, and fetch their plan, orders, and past refunds.',
  instructions: `You are an account specialist on a customer support team.

You can list all customers in the CRM, or look up a specific customer's
record and order history by email or ID using your tools. Report findings
concisely and factually: plan, tenure, orders with statuses and amounts,
and any past refunds. Do not make promises or decisions about refunds or
account changes — that is not your job.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  tools: { listCustomersTool, lookupCustomerTool, lookupOrdersTool },
});
