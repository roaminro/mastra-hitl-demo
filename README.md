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
| `index.ts` | Registers agents and a custom `POST /chat/:agentId` endpoint (`chat-route.ts`) |
| `chat-route.ts` | Custom chat route wrapping `handleChatStream`. Rewrites the approval run-ID via `getActiveThreadRunId` with a storage fallback for suspended runs, so approvals can resume after a page refresh or server restart |

### Web (`apps/web/src/`)

| File | Purpose |
| --- | --- |
| `components/assistant.tsx` | Runtime wiring: AI SDK transport to `http://localhost:4111/chat/support-agent`, approval auto-send, thread-list layout |
| `lib/mastra-threads.tsx` | Custom `RemoteThreadListAdapter` + history adapter backed by Mastra memory (`@mastra/client-js`) — thread list, titles, rename/archive/delete, and message history survive refresh |
| `components/assistant-ui/` | Assistant UI components, mostly generated; the customized ones are listed below |

## Assistant UI customizations

Assistant UI ships no Mastra integration and no concept of subagent delegation, so this demo adds custom code on top of the generated components. Notably, the **HITL approval flow needed zero changes to Assistant UI's primitives** — that was all server/transport wiring. The real custom work was bridging Mastra's thread/memory model and rendering subagent delegations.

**Net-new files**

| File | What it adds |
| --- | --- |
| `lib/mastra-threads.tsx` | A `RemoteThreadListAdapter` (list/create/rename/archive/unarchive/delete threads via `@mastra/client-js`) and a history adapter that converts `MastraMessage → UIMessage`. Tool calls are restored into `output-available` / `approval-requested` states so a refreshed thread keeps its tool calls and any still-pending Allow/Deny. |
| `components/assistant-ui/subagent-activity.tsx` | A `makeAssistantDataUI` renderer for Mastra's `data-tool-agent` stream part — the live "Delegating to X" card with nested tool calls/results, plus an agent-name fallback for when Mastra's resume-after-approval stream drops `data.id`. |

**Modified stock components**

| File | Change |
| --- | --- |
| `tool-fallback.tsx` | Real HITL approval wiring (`respondToApproval` / `resume` / `addResult`), gated so Allow/Deny only shows on a genuine approval/interrupt (not on history-restored calls). Suppresses duplicate `agent-*` delegation rows (the data-part owns the live card), renders an approval-only prompt for delegations awaiting a decision, and a compact **"Delegated to X"** card so finished delegations survive a page refresh. |
| `thread.tsx` | Auto-opens a tool group when it contains a tool that `requires-action`, so the approval prompt surfaces without manual expansion. Plus a cosmetic welcome heading. |
| `thread-list.tsx` | Adds an "Archived" section with unarchive-on-hover (the generated version is a flat list). |
| `tooltip-icon-button.tsx` | One-line shadcn Base UI compat fix (`delayDuration` → `delay`). |

**Runtime wiring** (`components/assistant.tsx`): `useChatRuntime` + `AssistantChatTransport` pointed at the custom `/chat/:agentId` route, `sendAutomaticallyWhen: allApprovalsResponded` (an approval auto-resumes the run), a fresh `threadId` per page load, and mounting `SubagentActivityUI`.

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
2. When the billing agent calls it, the run suspends and the stream emits a `tool-approval-request` part
3. Assistant UI renders the prompt; `sendAutomaticallyWhen: allApprovalsResponded` posts the decision back automatically
4. The custom chat route resolves the suspended run (via `getActiveThreadRunId`, falling back to storage) and resumes it; the tool either executes or is rejected
5. Because the suspended run is looked up from storage, a page refresh or server restart mid-approval still resumes correctly
