# Support Copilot — Mastra HITL Demo

A customer-support copilot demonstrating four [Mastra](https://mastra.ai) capabilities working together:

- **Subagents** — a supervisor `support-agent` delegates to an `account-agent` (CRM lookups), a `billing-agent` (refunds, which itself runs a nested `risk-agent`), and a `notifications-agent` (customer emails)
- **Human-in-the-loop approvals** — side-effecting tools (refunds, sending an email) require approval; the chat UI shows an Allow/Deny prompt before anything happens
- **Observational memory** — the supervisor compacts long threads and remembers customers and past tickets, with a `recall` tool so verbatim detail is never lost
- **MCP** — the `notifications-agent` reaches its email tools through a Mastra MCP server/client, with approval gated on the client per-tool

The story: an internal support rep chats with the copilot to handle customer tickets. Lookups are free, but refunds and customer emails suspend the run until the rep explicitly approves them in the UI.

## Structure

```
apps/
  server/   Mastra server — agents, tools, mock CRM data (port 4111)
  web/      Vite + React chat UI — Assistant UI + shadcn/Tailwind
```

### Server (`apps/server/src/mastra/`)

| File | Purpose |
| --- | --- |
| `agents/support-agent.ts` | Supervisor. Delegates to subagents; observational memory enabled (3k-token observation threshold, async buffering, temporal markers, **retrieval mode** so compacted detail stays recallable) |
| `agents/account-agent.ts` | Lists/looks up customers, plans, orders, refund history; pulls full ticket history via `fetch-account-history` |
| `agents/billing-agent.ts` | Issues refunds via the approval-gated `issue-refund` tool; runs a nested `risk-agent` risk check first |
| `agents/risk-agent.ts` | Nested subagent. Read-only fraud/abuse risk assessment for a refund |
| `agents/notifications-agent.ts` | Subagent that sends customer emails through the notifications MCP server; resolves its MCP tools lazily (per request) |
| `mcp/notifications-server.ts` | A Mastra `MCPServer` exposing `send-customer-email` (side-effecting) and `list-sent-emails` (read-only). Registered on the Mastra instance, so it's served at `/api/mcp/notifications-server/mcp` |
| `mcp/notifications-client.ts` | A Mastra `MCPClient` connecting to that server with a per-tool `requireToolApproval` predicate — sends need approval, reads don't |
| `tools/support-tools.ts` | `list-customers`, `lookup-customer`, `lookup-orders`, `fetch-account-history` (large payload — triggers OM compaction), `risk-check`, `issue-refund` (with `requireApproval`) |
| `tools/support-data.ts` | In-memory mock CRM (customers, orders, refunds) |
| `index.ts` | Registers agents, the MCP server, and a custom `POST /chat/:agentId` endpoint (`chat-route.ts`) |
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

Open the web UI (Vite prints the port). Copy/paste the prompts below to exercise each feature.

## Example prompts

The mock CRM has two customers: **Dana Reyes** (`cust_001`, `dana@example.com`) with orders `ord_1001` ($240) and `ord_1002` ($60), and **Sam Okafor** (`cust_002`, `sam@example.com`) with orders `ord_2001`/`ord_2002` ($900 each) and `ord_2003` ($1500).

**Subagent delegation (no approval)**

- `list customers please` — supervisor delegates to the account agent
- `what plan is sam@example.com on and what are his recent orders?` — account-agent lookup
- `pull up dana@example.com's account` — CRM lookup with refund history

**Human-in-the-loop refund approval**

- `customer dana@example.com wants a refund on ord_1002, defective` — supervisor delegates to the billing agent (which runs a nested risk check first), the run **suspends**, and **Allow/Deny** buttons appear. Click **Allow** to execute the refund or **Deny** to cancel it.
- `refund sam@example.com 1500 for ord_2003, onboarding cancelled` — same flow with a larger amount

**Human-in-the-loop email approval (via MCP)**

- `email dana@example.com to confirm her refund` — supervisor delegates to the notifications agent, which calls the MCP `send-customer-email` tool; it **suspends** for approval the same way before the email is sent
- `what emails have we sent to dana@example.com?` — the read-only `list-sent-emails` MCP tool runs **without** an approval prompt

**Observational memory compaction + recall** (do these as two turns in the same thread)

1. `pull the full account history for cust_002 and give me a thorough rundown of every ticket` — the large `fetch-account-history` payload crosses the 3k-token threshold, so memory **compacts** (watch for the "Memory compacted" / "Memory activated" cards)
2. `what was the exact ticketId of the 7th ticket?` — the detail was compacted out of the window, so the agent calls its `recall` tool to page back to the verbatim source

Threads persist in Mastra memory: refresh the page and the sidebar list, titles, and full history (including past approvals) are restored. Archived threads appear in an "Archived" section and can be unarchived.

### How Observational Memory compaction works

Run the two-turn OM prompt from [Example prompts](#example-prompts) to see this in action.

OM compacts the context window once a thread's messages cross the observation threshold (3k tokens here). The `fetch-account-history` tool returns a large payload (~5k tokens), so the Observer fires, compresses the raw messages into a dense observation log (~15× smaller), and evicts them from the window.

The thread renders the lifecycle inline via `om-activity.tsx`: **Memory compacted** (`data-om-observation-end`, with the token reduction) and **Memory activated** (`data-om-activation`, when raw messages are evicted). Only these terminal events are shown — Mastra emits OM lifecycle as separate, id-less stream parts, so an "in-progress" card (`observation-start`) can't be reconciled onto its completion and would spin forever; `data-om-status` fires every step and would stack. Because `retrieval: true` is set, nothing is truly lost — the verbatim-detail follow-up makes the agent call its `recall` tool to page back to the source.

## How the approval flow works

Two tools are approval-gated, each via a different Mastra mechanism:

- **`issue-refund`** (a normal Mastra tool) is defined with `requireApproval: true`.
- **`send-customer-email`** (an MCP tool) is gated on the `MCPClient` with a per-tool `requireToolApproval` predicate, so the read-only `list-sent-emails` tool runs freely while sends require approval.

Either way, the flow downstream is identical:

1. When a subagent calls the gated tool, the run suspends and the stream emits a `tool-approval-request` part
2. Assistant UI renders the prompt; `sendAutomaticallyWhen: allApprovalsResponded` posts the decision back automatically
3. The custom chat route resolves the suspended run (via `getActiveThreadRunId`, falling back to storage) and resumes it; the tool either executes or is rejected
4. Because the suspended run is looked up from storage, a page refresh or server restart mid-approval still resumes correctly
