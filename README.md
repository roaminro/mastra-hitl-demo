# Support Copilot — Mastra HITL Demo

A customer-support copilot demonstrating three [Mastra](https://mastra.ai) capabilities working together:

- **Subagents** — a supervisor `support-agent` delegates to an `account-agent` (CRM lookups) and a `billing-agent` (refunds)
- **Human-in-the-loop approvals** — the refund tool requires approval; the chat UI shows an Allow/Deny prompt before any money moves
- **Observational memory** — the supervisor remembers customers and past tickets across conversations

The story: an internal support rep chats with the copilot to handle customer tickets. Lookups are free, but refunds suspend the run until the rep explicitly approves them in the UI.

## Structure

```
apps/
  server/   Mastra server — agents, tools, mock CRM data (port 4111)
  web/      Vite + React chat UI — Assistant UI + shadcn/Tailwind
```

### Server (`apps/server/src/mastra/`)

| File | Purpose |
| --- | --- |
| `agents/support-agent.ts` | Supervisor. Delegates to subagents; observational memory enabled (4k-token observation threshold, async buffering, temporal markers) |
| `agents/account-agent.ts` | Lists/looks up customers, plans, orders, refund history |
| `agents/billing-agent.ts` | Issues refunds via the approval-gated `issue-refund` tool |
| `tools/support-tools.ts` | `list-customers`, `lookup-customer`, `lookup-orders`, `issue-refund` (with `requireApproval`) |
| `tools/support-data.ts` | In-memory mock CRM (customers, orders, refunds) |
| `index.ts` | Registers agents and the Assistant UI chat endpoint: `chatRoute({ path: '/chat/:agentId', version: 'v6' })` |

### Web (`apps/web/src/`)

| File | Purpose |
| --- | --- |
| `components/assistant.tsx` | Runtime wiring: AI SDK transport to `http://localhost:4111/chat/support-agent`, approval auto-send, thread-list layout |
| `lib/mastra-threads.tsx` | Custom `RemoteThreadListAdapter` + history adapter backed by Mastra memory (`@mastra/client-js`) — thread list, titles, rename/archive/delete, and message history survive refresh |
| `components/assistant-ui/` | Assistant UI components (thread, thread list, tool fallback with Allow/Deny buttons) |

## Setup

```shell
pnpm install
cp apps/server/.env.example apps/server/.env   # add your OPENROUTER_API_KEY
```

Models are routed through OpenRouter (`openai/gpt-5.4-mini` for agents, `google/gemini-2.5-flash` for the memory observer).

## Run

```shell
pnpm dev          # server (4111) + web in parallel
pnpm dev:server   # just the Mastra server / Studio
pnpm dev:web      # just the web UI
pnpm typecheck    # both apps
pnpm build        # both apps
```

Open the web UI (Vite prints the port) and try:

1. "list customers please" — supervisor delegates to the account agent
2. "customer dana@example.com wants a refund on ord_1002, defective" — supervisor delegates to the billing agent, the run **suspends**, and Allow/Deny buttons appear
3. Click **Allow** — the refund executes and the result streams back; **Deny** cancels it

Threads persist in Mastra memory: refresh the page and the sidebar list, titles, and full history (including past approvals) are restored. Archived threads appear in an "Archived" section and can be unarchived.

## How the approval flow works

1. `issue-refund` is defined with `requireApproval: true`
2. When the billing agent calls it, the run suspends and the stream emits a `tool-approval-request` part (requires `chatRoute({ version: 'v6' })`)
3. Assistant UI renders the prompt; `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` posts the decision back automatically
4. The run resumes and the tool either executes or is rejected
