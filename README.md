# Support Copilot — Mastra HITL Demo

A customer-support copilot demonstrating four [Mastra](https://mastra.ai) capabilities working together:

- **Subagents** — a supervisor `support-agent` delegates to an `account-agent` (CRM lookups), a `billing-agent` (refunds, which itself runs a nested `risk-agent`), and a `notifications-agent` (customer emails)
- **Human-in-the-loop approvals** — side-effecting tools (refunds, sending an email) require approval; the chat UI shows an Allow/Deny prompt before anything happens
- **Observational memory** — the supervisor compacts long threads and remembers customers and past tickets, with a `recall` tool so verbatim detail is never lost
- **MCP** — the `notifications-agent` reaches its email tools through a Mastra MCP server/client, with approval gated on the client per-tool
- **Dynamic tool discovery** — Mastra's `ToolSearchProcessor` shows up twice: a standalone `tools-agent` demos it directly (searchable library mixing local CRM tools with MCP tools, where the approval-gated MCP send tool still suspends when discovered — so discovery and HITL compose), and the `account-agent` subagent uses it *inside* the copilot, where delegation keeps all the search churn off the supervisor's stream
- **Dynamic model routing** — a standalone `routing-agent` demos a custom input processor that classifies each request with a nano-class model and overrides the run's model via `processInputStep()`: simple requests go to a cheap model, reasoning/coding to a strong one, and the decision is streamed to the UI so routing is never invisible

The story: an internal support rep chats with the copilot to handle customer tickets. Lookups are free, but refunds and customer emails suspend the run until the rep explicitly approves them in the UI. The sidebar also exposes two separate demo agents: **tool-search demo** and **model routing demo**.

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
| `agents/account-agent.ts` | Lists/looks up customers, plans, orders, refund history; pulls full ticket history via `fetch-account-history`. Owns **no static tools** — a `ToolSearchProcessor` (`autoLoad`, `storage: 'context'`) discovers the right read-only tool per request. Because it's a subagent, its `search_tools` calls stay folded inside the delegation and never surface on the supervisor's stream or history |
| `agents/billing-agent.ts` | Issues refunds via the approval-gated `issue-refund` tool; runs a nested `risk-agent` risk check first |
| `agents/risk-agent.ts` | Nested subagent. Read-only fraud/abuse risk assessment for a refund |
| `agents/notifications-agent.ts` | Subagent that sends customer emails through the notifications MCP server; resolves its MCP tools lazily (per request) |
| `agents/routing-agent.ts` | Standalone demo of dynamic model routing. Its static `model` is only a fallback — the `ModelRoutingProcessor` overrides the model per request (cheap tier `gpt-5.4-mini`, strong tier `gpt-5.4`) |
| `processors/model-routing-processor.ts` | Custom `Processor` implementing `processInputStep()`. A `gpt-5.4-nano` classifier labels the latest user message (`chat`/`lookup`/`writing`/`reasoning`/`code`, structured output, temp 0, input truncated to 2k chars); `reasoning`/`code` route to the strong model, everything else to the cheap one. Routes once at step 0 and pins the decision in `state` so tool-call continuations don't flip models; any classifier failure **fails open** to the strong model; the decision streams to the client as a `data-model-routing` chunk |
| `agents/tools-agent.ts` | Standalone demo of `ToolSearchProcessor`. Starts with `tools: {}` and an input processor holding a searchable library of local CRM tools **plus the MCP notification tools** (resolved via `notificationsClient.listTools()`) behind `search_tools`; `storage: 'context'` (restart-safe loaded-tool state) and `search.autoLoad: true` (matched tools activate immediately, no `load_tool` step). The processor is built lazily per request (cached) because the MCP fetch connects to a server that may not be up at module load |
| `mcp/notifications-server.ts` | A Mastra `MCPServer` exposing `send-customer-email` (side-effecting) and `list-sent-emails` (read-only). Registered on the Mastra instance, so it's served at `/api/mcp/notifications-server/mcp` |
| `mcp/notifications-client.ts` | A Mastra `MCPClient` connecting to that server with a per-tool `requireToolApproval` predicate — sends need approval, reads don't |
| `tools/support-tools.ts` | `list-customers`, `lookup-customer`, `lookup-orders`, `fetch-account-history` (large payload — triggers OM compaction), `risk-check`, `issue-refund` (with `requireApproval`) |
| `tools/support-data.ts` | In-memory mock CRM (customers, orders, refunds) |
| `index.ts` | Registers agents, the MCP server, and a custom `POST /chat/:agentId` endpoint (`chat-route.ts`) |
| `chat-route.ts` | Custom chat route wrapping `handleChatStream`. Rewrites the approval run-ID via `getActiveThreadRunId` with a storage fallback for suspended runs, so approvals can resume after a page refresh or server restart |

### Web (`apps/web/src/`)

| File | Purpose |
| --- | --- |
| `components/assistant.tsx` | Runtime wiring: AI SDK transport to the custom `/chat/:agentId` route, approval auto-send, thread-list layout, and a sidebar **agent selector** that retargets the transport between the support copilot and the tool-search demo |
| `lib/mastra-threads.tsx` | Custom `RemoteThreadListAdapter` + history adapter backed by Mastra memory (`@mastra/client-js`) — thread list, titles, rename/archive/delete, and message history survive refresh. Also exports the selectable `AGENTS` list |
| `components/assistant-ui/` | Assistant UI components, mostly generated; the customized ones are listed below |

## Assistant UI customizations

Assistant UI ships no Mastra integration and no concept of subagent delegation, so this demo adds custom code on top of the generated components. Notably, the **HITL approval flow needed zero changes to Assistant UI's primitives** — that was all server/transport wiring. The real custom work was bridging Mastra's thread/memory model and rendering subagent delegations.

**Net-new files**

| File | What it adds |
| --- | --- |
| `lib/mastra-threads.tsx` | A `RemoteThreadListAdapter` (list/create/rename/archive/unarchive/delete threads via `@mastra/client-js`) and a history adapter that converts `MastraMessage → UIMessage`. Tool calls are restored into `output-available` / `approval-requested` states so a refreshed thread keeps its tool calls and any still-pending Allow/Deny. |
| `components/assistant-ui/subagent-activity.tsx` | A `makeAssistantDataUI` renderer for Mastra's `data-tool-agent` stream part — the live "Delegating to X" card with nested tool calls/results, plus an agent-name fallback for when Mastra's resume-after-approval stream drops `data.id`. Hides the `search_tools`/`load_tool` meta-tools inside the card, so a subagent's tool discovery shows only the real tool it activated. |
| `components/assistant-ui/model-routing.tsx` | A `makeAssistantDataUI` renderer for the `data-model-routing` chunk — a collapsible "Routed to `<model>`" card with a CHEAP/STRONG badge, the classifier label and latency, and the classifier's reasoning inside (fail-open decisions get a shield icon). |

**Modified stock components**

| File | Change |
| --- | --- |
| `tool-fallback.tsx` | Real HITL approval wiring (`respondToApproval` / `resume` / `addResult`), gated so Allow/Deny only shows on a genuine approval/interrupt (not on history-restored calls). Suppresses duplicate `agent-*` delegation rows (the data-part owns the live card), renders an approval-only prompt for delegations awaiting a decision, and a compact **"Delegated to X"** card so finished delegations survive a page refresh. |
| `thread.tsx` | Auto-opens a tool group when it contains a tool that `requires-action`, so the approval prompt surfaces without manual expansion. Plus a cosmetic welcome heading. |
| `thread-list.tsx` | Adds an "Archived" section with unarchive-on-hover (the generated version is a flat list). |
| `tooltip-icon-button.tsx` | One-line shadcn Base UI compat fix (`delayDuration` → `delay`). |

**Runtime wiring** (`components/assistant.tsx`): `useChatRuntime` + `AssistantChatTransport` pointed at the custom `/chat/:agentId` route, `sendAutomaticallyWhen: allApprovalsResponded` (an approval auto-resumes the run), a fresh `threadId` per page load, and mounting `SubagentActivityUI` and `ModelRoutingUI`.

### Agent selector + tool-search demo

The sidebar has an **Agent** dropdown that switches which agent answers — the *Support copilot*, the *Tool search demo*, or the *Model routing demo*. Selecting an agent rebuilds the `AssistantChatTransport` so its `/chat/:agentId` URL follows the choice; everything else is unchanged. The thread list, titles, and history are **shared** across agents because Mastra scopes memory threads by `resourceId` (`rep_001`), not by agent — so switching agents keeps the same ticket list, and a conversation can contain turns from any of the agents.

The *Tool search demo* points at `tools-agent`, which has no tools loaded up front. It calls the `search_tools` meta-tool to find a tool by keywords, the match is auto-activated (no `load_tool` step), and it answers on the next turn. Because the processor uses `storage: 'context'`, an already-discovered tool stays loaded for later turns in the same thread — a follow-up lookup skips the search and goes straight to the tool.

The library isn't just local tools: the MCP notification tools are spread into it via `notificationsClient.listTools()`, which returns the same `Record<string, Tool>` shape the processor expects. The key point is that the two mechanisms operate at different layers and compose — `ToolSearchProcessor` controls *discovery*, while the `MCPClient`'s per-tool `requireToolApproval` controls *execution*. So the agent can search for and auto-load `send-customer-email`, but calling it still suspends for approval, while the read-only `list-sent-emails` runs freely. (One nuance of `storage: 'context'`: a loaded tool only stays loaded while its `search_tools` result is in the message window, so a brand-new turn may re-search before sending.)

### Tool search on a subagent (keeping discovery out of the user-facing stream)

Putting a `ToolSearchProcessor` directly on a user-facing agent has a UX cost: its `search_tools` calls stream as ordinary tool-call parts, and the model may even narrate "let me search for a tool…" in its text. This demo also shows the structural fix — put the processor on a **subagent**. The `account-agent` has no static tools; it discovers its read-only CRM tools per request. Because subagent delegation folds all inner activity into a single `data-tool-agent` progress part, the discovery churn never appears as top-level tool calls in the supervisor's stream or persisted history — the rep just sees "Delegating to Account" and the real tool it ended up using (the delegation card filters out the `search_tools`/`load_tool` meta rows). Verified by `subagent-toolsearch-visibility.probe.test.ts`, which asserts the search meta-tools appear zero times at the top level.

## Setup

```shell
pnpm install
cp apps/server/.env.example apps/server/.env   # add your OPENROUTER_API_KEY
```

Models are routed through OpenRouter (`openai/gpt-5.4-mini` for agents, `google/gemini-2.5-flash` for the memory observer; the routing demo additionally uses `openai/gpt-5.4-nano` as its classifier and `openai/gpt-5.4` as its strong tier).

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

**Dynamic tool discovery** (switch the sidebar **Agent** dropdown to *Tool search demo* first)

- `look up dana@example.com and tell me her plan` — the agent calls `search_tools`, the matched `lookup-customer` tool auto-loads, and it answers (**Dana Reyes — Pro plan**)
- `now what's the refund risk on ord_2001 at $1500?` — a different query searches and auto-loads `risk-check` instead
- ask a second customer lookup in the same thread — it reuses the already-loaded tool and skips the search (`storage: 'context'`)
- `email sam@example.com to confirm his refund on ord_2003 was processed` — `search_tools` finds and auto-loads the **MCP** `send-customer-email` tool, then calling it **suspends** for approval (**Allow/Deny**). If it stops after the search, nudge it with `send it now`
- `what emails have we sent to sam@example.com?` — searches and auto-loads the read-only MCP `list-sent-emails` tool, which runs **without** an approval prompt

**Dynamic model routing** (switch the sidebar **Agent** dropdown to *Model routing demo* first)

- `hey, how's it going?` — routes to the **cheap** tier (`gpt-5.4-mini`), labeled `chat`
- `what's the capital of Australia?` — cheap tier, labeled `lookup`
- `write a TypeScript function that balances a red-black tree and explain the invariants` — routes to the **strong** tier (`gpt-5.4`), labeled `code`
- `analyze the trade-offs between event sourcing and CRUD for a billing system` — strong tier, labeled `reasoning`

Each response gets a **"Routed to …"** card above it — expand it to see the classifier's one-line reasoning and latency.

Threads persist in Mastra memory: refresh the page and the sidebar list, titles, and full history (including past approvals) are restored. Archived threads appear in an "Archived" section and can be unarchived.

### How Observational Memory compaction works

Run the two-turn OM prompt from [Example prompts](#example-prompts) to see this in action.

OM compacts the context window once a thread's messages cross the observation threshold (3k tokens here). The `fetch-account-history` tool returns a large payload (~5k tokens), so the Observer fires, compresses the raw messages into a dense observation log (~15× smaller), and evicts them from the window.

The thread renders the lifecycle inline via `om-activity.tsx`: **Memory compacted** (`data-om-observation-end`, with the token reduction) and **Memory activated** (`data-om-activation`, when raw messages are evicted). Only these terminal events are shown — Mastra emits OM lifecycle as separate, id-less stream parts, so an "in-progress" card (`observation-start`) can't be reconciled onto its completion and would spin forever; `data-om-status` fires every step and would stack. Because `retrieval: true` is set, nothing is truly lost — the verbatim-detail follow-up makes the agent call its `recall` tool to page back to the source.

## How model routing works

The *Model routing demo* agent (`routing-agent`) shows how to pick a model per request with a custom input processor instead of hardcoding one. `ModelRoutingProcessor` implements `processInputStep()`, which runs at every step of the agentic loop and can return `{ model }` to override the model for that step:

1. At **step 0**, a `gpt-5.4-nano` classifier (an internal `Agent` with structured output, temperature 0) labels the latest user message as `chat`, `lookup`, `writing`, `reasoning`, or `code`. Input to the classifier is truncated to 2k chars — a routing call costs ~$0.00002.
2. `reasoning`/`code` route to the **strong** model (`gpt-5.4`); everything else routes to the **cheap** one (`gpt-5.4-mini`). The label set classifies *intent*, not abstract "difficulty" — tiny models are reliable at the former, unreliable at the latter.
3. The decision is pinned in the processor's `state`, so later steps (tool-call continuations) reuse it instead of re-classifying — the model never flips mid-run.
4. Any classifier failure (or empty input) **fails open** to the strong model: mis-routing an easy query up wastes cents; mis-routing a hard query down is a silent quality failure.
5. The decision is streamed to the client as a `data-model-routing` chunk (and logged server-side), which `model-routing.tsx` renders as the "Routed to …" card — routing is always visible, never a silent downgrade.

The classifier adds ~1s of latency per request; in production you'd swap it for a fine-tuned classifier or embedding router (<5ms) once you have labeled traffic. Verified by `model-routing.live.test.ts`, which asserts a trivial greeting routes cheap and a multi-step coding request routes strong against the live API.

## How the approval flow works

Two tools are approval-gated, each via a different Mastra mechanism:

- **`issue-refund`** (a normal Mastra tool) is defined with `requireApproval: true`.
- **`send-customer-email`** (an MCP tool) is gated on the `MCPClient` with a per-tool `requireToolApproval` predicate, so the read-only `list-sent-emails` tool runs freely while sends require approval.

Either way, the flow downstream is identical:

1. When a subagent calls the gated tool, the run suspends and the stream emits a `tool-approval-request` part
2. Assistant UI renders the prompt; `sendAutomaticallyWhen: allApprovalsResponded` posts the decision back automatically
3. The custom chat route resolves the suspended run (via `getActiveThreadRunId`, falling back to storage) and resumes it; the tool either executes or is rejected
4. Because the suspended run is looked up from storage, a page refresh or server restart mid-approval still resumes correctly
