import { MCPServer } from '@mastra/mcp';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { customers } from '../tools/support-data';

// A record of notifications "sent" via the MCP server, so the demo can show
// that the side effect actually happened after approval.
export const sentNotifications: {
  notificationId: string;
  customerId: string;
  email: string;
  subject: string;
  body: string;
  sentAt: string;
}[] = [];

const sendCustomerEmailTool = createTool({
  id: 'send-customer-email',
  description:
    'Send an email to a customer (e.g. a refund confirmation or follow-up). This is a real side effect: it delivers a message to the customer.',
  inputSchema: z.object({
    customerId: z.string().describe('The customer to email'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body text'),
  }),
  outputSchema: z.object({
    notificationId: z.string(),
    customerId: z.string(),
    email: z.string(),
    sentAt: z.string(),
  }),
  execute: async ({ customerId, subject, body }) => {
    const customer = customers.find(c => c.customerId === customerId);
    if (!customer) {
      throw new Error(`Customer ${customerId} not found`);
    }
    const notification = {
      notificationId: `ntf_${Date.now()}`,
      customerId,
      email: customer.email,
      subject,
      body,
      sentAt: new Date().toISOString(),
    };
    sentNotifications.push(notification);
    return {
      notificationId: notification.notificationId,
      customerId,
      email: customer.email,
      sentAt: notification.sentAt,
    };
  },
});

// A read-only tool, to show that approval can be scoped per-tool on the client.
const listSentEmailsTool = createTool({
  id: 'list-sent-emails',
  description: 'List emails already sent to a customer. Read-only.',
  inputSchema: z.object({
    customerId: z.string(),
  }),
  outputSchema: z.object({
    emails: z.array(
      z.object({
        notificationId: z.string(),
        subject: z.string(),
        sentAt: z.string(),
      }),
    ),
  }),
  execute: async ({ customerId }) => ({
    emails: sentNotifications
      .filter(n => n.customerId === customerId)
      .map(({ notificationId, subject, sentAt }) => ({ notificationId, subject, sentAt })),
  }),
});

export const notificationsServer = new MCPServer({
  id: 'notifications-server',
  name: 'Customer Notifications',
  version: '1.0.0',
  description:
    'Exposes customer notification tools (send email, list sent emails) over MCP.',
  tools: {
    sendCustomerEmailTool,
    listSentEmailsTool,
  },
});
