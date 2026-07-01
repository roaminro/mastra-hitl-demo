import { Agent } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import {
  fetchAccountHistoryTool,
  listCustomersTool,
  lookupCustomerTool,
  lookupOrdersTool,
  riskCheckTool,
} from '../tools/support-tools';

/**
 * The account-agent is where tool search lives in this demo.
 *
 * Instead of exposing its read-only tool library statically, it owns a
 * `ToolSearchProcessor`: on each turn it gets `search_tools` (and, since
 * `autoLoad` is on, no separate `load_tool`) to discover and activate only the
 * tools that fit the request. This keeps discovery — and its noise — INSIDE the
 * subagent. A probe (subagent-toolsearch-visibility.probe.test.ts) confirmed
 * that when the supervisor delegates here, the `search_tools` calls never appear
 * on the supervisor's own stream or persisted history; only the delegation and
 * the subagent's final answer surface up top. So the user-facing copilot stays
 * lean and leak-free with zero custom processor code.
 *
 * `storage: 'context'` derives loaded-tool state from the conversation messages,
 * so it is restart-safe and needs no memory on this subagent.
 */
export const accountAgent = new Agent({
  id: 'account-agent',
  name: 'Account Specialist',
  description:
    'Looks up customer records and order history. Read-only: use this to list all customers, identify a customer, and fetch their plan, orders, and past refunds.',
  instructions: `You are an account specialist on a customer support team.

You do not have your tools loaded up front. Each turn you have a
"search_tools" tool: search it with keywords describing what you need
(for example "customer plan lookup", "orders and refunds", "full ticket
history", "refund risk"), and the matching tools are activated for you to
call. Search first, then use the tool that fits.

You can list all customers in the CRM, or look up a specific customer's
record and order history by email or ID. When the rep needs full
background on a customer, fetch their complete support ticket history.
Report findings concisely and factually: plan, tenure, orders with
statuses and amounts, and any past refunds. Do not make promises or
decisions about refunds or account changes — that is not your job.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  inputProcessors: [
    new ToolSearchProcessor({
      tools: {
        listCustomersTool,
        lookupCustomerTool,
        lookupOrdersTool,
        riskCheckTool,
        fetchAccountHistoryTool,
      },
      search: { topK: 3, autoLoad: true },
      storage: 'context',
    }),
  ],
});
