import { MCPClient } from '@mastra/mcp';

// Base URL of the Mastra server hosting the registered MCP server.
// The dev server exposes a registered `mcpServers` entry at
// `/api/mcp/<serverId>/mcp`. Our server id is `notifications-server`.
const MCP_BASE_URL =
  process.env.MASTRA_MCP_BASE_URL ?? 'http://localhost:4111';

export const notificationsClient = new MCPClient({
  id: 'notifications-client',
  servers: {
    notifications: {
      url: new URL(`${MCP_BASE_URL}/api/mcp/notifications-server/mcp`),
      // Human-in-the-loop: require approval before any side-effecting tool
      // runs, but let the read-only tool through without a prompt.
      requireToolApproval: ({ toolName }) => {
        // Tool names are namespaced by the server key (e.g. `notifications_...`).
        if (toolName.endsWith('list-sent-emails') || toolName.endsWith('listSentEmailsTool')) {
          return false;
        }
        // Everything else (notably send-customer-email) needs approval.
        return true;
      },
    },
  },
});
