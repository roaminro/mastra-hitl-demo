import { Agent } from '@mastra/core/agent';
import { notificationsClient } from '../mcp/notifications-client';
import { lookupCustomerTool } from '../tools/support-tools';

export const notificationsAgent = new Agent({
  id: 'notifications-agent',
  name: 'Notifications Specialist',
  description:
    'Sends notifications (emails) to customers via the notifications MCP server. Sending an email is a real side effect and requires human approval.',
  instructions: `You are a notifications specialist on a customer support team.

You send emails to customers — for example, refund confirmations or follow-ups.
You have access to tools from the notifications MCP server:
- send a customer email (this delivers a real message and requires approval)
- list emails already sent to a customer (read-only)

When asked to email a customer, look up the customer if you only have their
email or name, then call the send-email tool with a clear subject and body.
Sending requires approval from the support rep — if it is declined, report that
the email was not sent and do not retry. After a successful send, report exactly
what the tool returned (notification ID, email address). Never invent delivery
confirmations or timestamps.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  // Resolve tools lazily (per request) rather than at module load. The MCP
  // server lives in this same Mastra process, so it isn't listening yet when
  // this module is first evaluated. By the time a request runs, it is.
  tools: async () => ({
    lookupCustomerTool,
    // MCP tools are namespaced by server key (e.g. `notifications_send-customer-email`).
    ...(await notificationsClient.listTools()),
  }),
});
