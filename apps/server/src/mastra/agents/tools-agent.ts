import { Agent } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import {
  fetchAccountHistoryTool,
  listCustomersTool,
  lookupCustomerTool,
  lookupOrdersTool,
  riskCheckTool,
} from '../tools/support-tools';
import { notificationsClient } from '../mcp/notifications-client';

// Demonstrates Mastra's ToolSearchProcessor: instead of handing the agent its
// whole tool library upfront (which bloats the prompt with every tool schema),
// the library is searchable and the agent discovers tools on demand.
//
// The library mixes local tools and tools served over MCP. MCP tools resolved
// via `notificationsClient.listTools()` come back as a plain
// `Record<string, Tool>` — the exact shape ToolSearchProcessor's `tools`
// option wants — so they drop straight into the searchable library. Each MCP
// tool still carries the client's `requireToolApproval` gating, so discovery
// (this processor) and execution-time approval (the MCP client) compose: the
// agent can *find* `send-customer-email` via search, but calling it suspends
// for approval.
//
// Config choices for this demo:
// - storage: 'context'  -> loaded-tool state is derived from the conversation
//   messages, so it is restart-safe and needs no extra memory wiring.
// - search.autoLoad: true -> tools returned by `search_tools` are activated
//   immediately (no separate `load_tool` step), collapsing discovery into a
//   single turn. topK stays small because every match is activated.
//
// `listTools()` connects to the MCP server, which may not be listening at
// module load. So the processor is built lazily per request via the dynamic
// `inputProcessors` function, and the MCP tool fetch is cached after the first
// successful resolution.
let cachedProcessor: ToolSearchProcessor | undefined;

async function buildToolSearch(): Promise<ToolSearchProcessor> {
  if (cachedProcessor) return cachedProcessor;

  const mcpTools = await notificationsClient.listTools();

  cachedProcessor = new ToolSearchProcessor({
    tools: {
      listCustomersTool,
      lookupCustomerTool,
      lookupOrdersTool,
      riskCheckTool,
      fetchAccountHistoryTool,
      // MCP tools (namespaced, e.g. `notifications_sendCustomerEmailTool`,
      // `notifications_listSentEmailsTool`).
      ...mcpTools,
    },
    search: {
      topK: 3,
      autoLoad: true,
    },
    storage: 'context',
  });

  return cachedProcessor;
}

export const toolsAgent = new Agent({
  id: 'tools-agent',
  name: 'Tool Search Demo',
  description:
    'Demo agent for Mastra ToolSearchProcessor. Starts with no tools and discovers CRM (read-only) and MCP notification tools on demand via search_tools (context storage, autoLoad). Sending an email still requires approval.',
  instructions: `You are a customer-support data assistant.

You start with NO domain tools loaded. To do anything, you must first find the
right tool with the "search_tools" meta-tool, using clear keywords describing
what you need (for example: "customer record", "orders", "refund risk",
"support ticket history", "send email", "sent email history"). The matching
tool is activated automatically and becomes available on your next turn — there
is no separate load step. Then call that tool to answer.

Always search before claiming you cannot do something: the underlying library
can list customers, look up a customer by email or ID, list a customer's
orders and refunds, assess refund risk for an order, fetch a customer's full
support history, send a customer an email, and list previously sent emails.

You may NOT perform refunds or account changes. Sending an email is allowed but
requires human approval, which happens automatically when you call the send
tool — just call it and the approval prompt is shown to the rep.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  tools: {},
  inputProcessors: async () => [await buildToolSearch()],
});
