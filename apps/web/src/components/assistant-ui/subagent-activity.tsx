"use client";

import { memo, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  NetworkIcon,
  WrenchIcon,
} from "lucide-react";
import { makeAssistantDataUI, useAuiState } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * Shape of the `data-tool-agent` part streamed by `@mastra/ai-sdk` while a
 * supervisor delegates to a subagent. The buffered state accumulates live as
 * the subagent generates: `text` grows token-by-token, `toolCalls` /
 * `toolResults` fill in as the subagent uses its own tools, and `status`
 * flips from "running" to "finished" when the delegation completes.
 *
 * `data.id` is the subagent's name (e.g. "billing-agent"), not a run ID.
 */
type SubagentToolCall = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
};

type SubagentToolResult = SubagentToolCall & {
  result?: unknown;
};

type SubagentStep = {
  toolCalls?: SubagentToolCall[];
  toolResults?: SubagentToolResult[];
};

type SubagentResponseMessage = {
  content?: unknown;
};

export type SubagentData = {
  /** Subagent name, e.g. "account-agent". */
  id: string;
  text: string;
  status: "running" | "finished" | string;
  // While the subagent is running, tool calls/results live at the top level.
  // On the final chunk, `@mastra/ai-sdk` flushes them into `steps[]` and
  // empties these arrays — so we merge both sources below.
  toolCalls: SubagentToolCall[];
  toolResults: SubagentToolResult[];
  steps?: SubagentStep[];
  // Full model conversation; the only place tool names survive on the
  // resume-after-approval stream (where toolCalls/steps come back empty).
  response?: { messages?: SubagentResponseMessage[] };
};

/** Pull every tool name referenced anywhere in the buffered subagent state. */
const allToolNames = (data: SubagentData): string[] => {
  const names = new Set<string>();
  for (const c of data.toolCalls ?? []) if (c?.toolName) names.add(c.toolName);
  for (const r of data.toolResults ?? [])
    if (r?.toolName) names.add(r.toolName);
  for (const step of data.steps ?? []) {
    for (const c of step.toolCalls ?? []) if (c?.toolName) names.add(c.toolName);
    for (const r of step.toolResults ?? [])
      if (r?.toolName) names.add(r.toolName);
  }
  for (const m of data.response?.messages ?? []) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const tn = (part as { toolName?: string })?.toolName;
        if (tn) names.add(tn);
      }
    }
  }
  return [...names];
};

const isAgentTool = (toolName?: string): boolean =>
  typeof toolName === "string" && toolName.startsWith("agent-");

/**
 * Meta-tools injected by a subagent's `ToolSearchProcessor` (the account-agent
 * uses one for dynamic tool discovery). These are plumbing — the subagent uses
 * them to FIND its real tools — so they'd be noise as inner rows in the
 * delegation card. Hide them; the real tool the search activated still shows.
 */
const SEARCH_META_TOOLS = new Set(["search_tools", "load_tool"]);
const isSearchMetaTool = (toolName?: string): boolean =>
  typeof toolName === "string" && SEARCH_META_TOOLS.has(toolName);

/** Tools that should not render as their own flat row in a delegation card. */
const isHiddenInnerTool = (toolName?: string): boolean =>
  isAgentTool(toolName) || isSearchMetaTool(toolName);

/**
 * Collect the subagent's OWN tool calls/results from the live top-level arrays
 * AND the finalized `steps[]`, so the tool activity stays visible after
 * completion. Nested `agent-*` delegations are excluded here — they render as
 * nested cards via `collectNestedAgents` instead of flat tool rows. Tool-search
 * meta-tools (`search_tools`/`load_tool`) are excluded too — see
 * `isSearchMetaTool`.
 */
const collectTools = (data: SubagentData) => {
  const calls = new Map<string, SubagentToolCall>();
  const results = new Map<string, SubagentToolResult>();

  const ingest = (
    cs: SubagentToolCall[] = [],
    rs: SubagentToolResult[] = [],
  ) => {
    for (const c of cs)
      if (c?.toolCallId && !isHiddenInnerTool(c.toolName)) calls.set(c.toolCallId, c);
    for (const r of rs)
      if (r?.toolCallId && !isHiddenInnerTool(r.toolName)) results.set(r.toolCallId, r);
  };

  ingest(data.toolCalls, data.toolResults);
  for (const step of data.steps ?? []) ingest(step.toolCalls, step.toolResults);

  return { calls: [...calls.values()], results };
};

/**
 * A child delegation extracted from a parent subagent's buffer. The probe
 * (nested-delegation.probe.test.ts) confirmed that when a subagent delegates,
 * the child surfaces as an `agent-*` tool-call/tool-result pair inside the
 * parent's `steps[]` and `response.messages` — NOT as its own top-level
 * `data-tool-agent` part. We reconstruct a `SubagentData` for each child so the
 * card can recurse and show the full multi-level chain.
 */
const agentToolToName = (toolName: string): string =>
  // "agent-billingAgent" -> "billingAgent"; humanized later.
  toolName.replace(/^agent-/, "");

type ToolPart = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
};

/**
 * Tool results that ride inside `response.messages` now use the AI SDK v6
 * tool-output envelope (`{ type: "json" | "text" | ..., value: ... }`).
 * Rendering the envelope verbatim shows raw `{"type":"json","value":{...}}`
 * JSON in the card, so peel it off; plain (legacy) values pass through.
 */
const unwrapToolOutput = (value: unknown): unknown => {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    "value" in value
  ) {
    const { type, value: inner } = value as { type: unknown; value: unknown };
    if (
      type === "json" ||
      type === "text" ||
      type === "error-json" ||
      type === "error-text"
    ) {
      return inner;
    }
  }
  return value;
};

/** Walk a subagent's buffer and return every nested `agent-*` delegation. */
const collectNestedAgents = (data: SubagentData): SubagentData[] => {
  const calls = new Map<string, ToolPart>();
  const results = new Map<string, ToolPart>();

  const consider = (part: ToolPart | undefined) => {
    if (!part?.toolCallId || !isAgentTool(part.toolName)) return;
    const hasResult =
      part.type === "tool-result" || "output" in part || "result" in part;
    if (hasResult) results.set(part.toolCallId, part);
    else calls.set(part.toolCallId, part);
  };

  for (const c of data.toolCalls ?? []) consider(c as ToolPart);
  for (const r of data.toolResults ?? []) consider(r as ToolPart);
  for (const step of data.steps ?? []) {
    for (const c of step.toolCalls ?? []) consider(c as ToolPart);
    for (const r of step.toolResults ?? []) consider(r as ToolPart);
  }
  for (const m of data.response?.messages ?? []) {
    if (Array.isArray(m.content)) for (const part of m.content) consider(part as ToolPart);
  }

  const ids = new Set([...calls.keys(), ...results.keys()]);
  return [...ids].map((id) => {
    const call = calls.get(id);
    const result = results.get(id);
    const output = unwrapToolOutput(result?.output ?? result?.result);
    const promptInput = (call?.input ?? call?.args ?? {}) as { prompt?: string };
    const outText =
      typeof output === "string"
        ? output
        : (output as { text?: string })?.text ??
          (output ? JSON.stringify(output, null, 2) : "");
    return {
      id: agentToolToName(call?.toolName ?? result?.toolName ?? ""),
      text: outText,
      status: result ? "finished" : "running",
      toolCalls: [],
      toolResults: [],
      // The child's own inner output may itself contain a nested delegation;
      // recursion handles arbitrary depth via `response.messages`.
      response:
        output && typeof output === "object"
          ? (output as SubagentData["response"])
          : undefined,
      _childPrompt: promptInput.prompt,
    } as SubagentData & { _childPrompt?: string };
  });
};

/**
 * Persisted shape of a completed `agent-*` delegation's `output` (a.k.a. the
 * tool-call `result`). When a delegation finishes, Mastra stores the subagent's
 * summary here — but the ephemeral `data-tool-agent` progress part is NOT
 * persisted. So on refresh this `output` is the only record of the delegation.
 *
 * It mirrors the live buffer's tail: a `text` summary plus `subAgentToolResults`
 * (the subagent's own tool calls, incl. any nested `agent-*` delegations) and a
 * `response.messages` transcript. `restoredOutputToSubagentData` reshapes it
 * into `SubagentData` so the SAME recursive `SubagentCard` renders it — making
 * recalled history visually identical to the live card.
 */
type RestoredAgentOutput = {
  text?: string;
  subAgentToolResults?: SubagentToolResult[];
  response?: { messages?: SubagentResponseMessage[] };
};

/**
 * Convert a persisted `agent-*` tool-call output into the `SubagentData` shape
 * consumed by `SubagentCard`. `subAgentToolResults` becomes both `toolResults`
 * and (so the tool rows show their request) synthesized `toolCalls`; nested
 * `agent-*` results carried inside are surfaced by `collectNestedAgents` via the
 * same arrays / `response.messages`. Returns null if the output isn't a
 * recognizable delegation summary.
 */
export const restoredOutputToSubagentData = (
  toolName: string,
  output: unknown,
): SubagentData | null => {
  if (!output || typeof output !== "object") return null;
  const o = output as RestoredAgentOutput;
  const toolResults = Array.isArray(o.subAgentToolResults)
    ? o.subAgentToolResults
    : [];
  // Synthesize matching tool-calls so SubagentToolRow can show args + result.
  const toolCalls: SubagentToolCall[] = toolResults.map((r) => ({
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    args: r.args,
  }));
  return {
    id: agentToolToName(toolName),
    text: typeof o.text === "string" ? o.text : "",
    status: "finished",
    toolCalls,
    toolResults,
    response: o.response,
  };
};

const humanizeAgentName = (id: string) =>
  id
    .replace(/[-_]?agent$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || id;

/**
 * Resolve a display name for the subagent.
 *
 * Normally `data.id` is the subagent name (e.g. "billing-agent"). But when a
 * suspended subagent is resumed after approval, Mastra's resume stream emits
 * the `data-tool-agent` buffer with an empty `data.id` (reproduced against
 * @mastra/core — see MASTRA_DX_FEEDBACK.md). In that case we infer the name
 * from a uniquely-owned tool when possible, else fall back to "Subagent" so
 * the card is never nameless.
 */
/**
 * Ordered by specificity: uniquely-owned tools first. `lookupCustomerTool` is
 * shared between the account and notifications agents, so it can only be a
 * last resort — checking it early mislabeled a resumed Notifications
 * delegation as "Account".
 */
const toolToAgent: [matches: (toolName: string) => boolean, agent: string][] = [
  [(t) => t.startsWith("notifications_"), "notifications-agent"],
  [(t) => t === "issueRefundTool", "billing-agent"],
  [(t) => t === "listCustomersTool", "account-agent"],
  [(t) => t === "fetchAccountHistoryTool", "account-agent"],
  // Shared tools are the weakest signals, checked last: riskCheckTool is
  // owned by risk + account, lookupCustomerTool by account + notifications.
  [(t) => t === "riskCheckTool", "risk-agent"],
  [(t) => t === "lookupCustomerTool", "account-agent"],
];

const isFulfillmentA2AAgent = (data: SubagentData): boolean =>
  data.id.toLowerCase().includes("fulfillment");

const resolveAgentName = (data: SubagentData): string => {
  if (isFulfillmentA2AAgent(data)) return "Fulfillment Partner";
  if (data.id) return humanizeAgentName(data.id);
  const names = allToolNames(data);
  for (const [matches, agent] of toolToAgent) {
    if (names.some(matches)) return humanizeAgentName(agent);
  }
  return "Subagent";
};

const SubagentToolRow = ({
  call,
  result,
}: {
  call: SubagentToolCall;
  result?: SubagentToolResult;
}) => {
  const [open, setOpen] = useState(false);
  const done = result !== undefined;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group/subtool flex w-fit items-center gap-1.5 py-0.5 text-xs transition-colors">
        {done ? (
          <CheckIcon className="size-3 shrink-0" />
        ) : (
          <LoaderIcon className="size-3 shrink-0 animate-spin" />
        )}
        <WrenchIcon className="size-3 shrink-0 opacity-70" />
        <span className="font-mono">{call.toolName}</span>
        <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=closed]/subtool:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="ps-5 pt-1 pb-1">
          {call.args !== undefined && (
            <pre className="bg-muted/50 text-muted-foreground mb-1 rounded-md p-2 text-[11px] whitespace-pre-wrap">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          )}
          {done && result?.result !== undefined && (
            <pre className="bg-muted/50 text-muted-foreground rounded-md p-2 text-[11px] whitespace-pre-wrap">
              {(() => {
                const value = unwrapToolOutput(result.result);
                return typeof value === "string"
                  ? value
                  : JSON.stringify(value, null, 2);
              })()}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

// Cap recursion so a malformed/cyclic buffer can't blow the stack.
const MAX_DEPTH = 4;

export const SubagentCard = ({
  data,
  prompt,
  footer,
  depth = 0,
}: {
  data: SubagentData;
  prompt?: string;
  /**
   * Extra content rendered at the bottom of the card body. Used to slot the
   * Allow/Deny approval prompt inside the card when a delegation is suspended
   * waiting on a decision (e.g. restored from history after a page refresh),
   * so the approver still sees the "Delegating to X" framing and request.
   */
  footer?: ReactNode;
  depth?: number;
}) => {
  const running = data.status !== "finished";
  // Auto-expand while the subagent is actively working so the rep sees
  // progress; let them collapse it once done.
  const [open, setOpen] = useState(true);

  const name = resolveAgentName(data);
  const isA2A = isFulfillmentA2AAgent(data);
  const { calls: toolCalls, results: resultsByCallId } = collectTools(data);
  const nestedAgents =
    depth < MAX_DEPTH ? collectNestedAgents(data) : [];

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border/60 bg-muted/20 my-1 w-full rounded-lg border"
    >
      <CollapsibleTrigger className="group/agent text-foreground flex w-full items-center gap-2 px-3 py-2 text-sm">
        {running ? (
          <LoaderIcon className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : (
          <CheckIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
        )}
        <span className="flex min-w-0 items-center gap-2 text-start leading-none">
          <span className="relative inline-block">
            <span>
              {running ? "Delegating to" : "Delegated to"} <b>{name}</b>
            </span>
            {running && (
              <span
                aria-hidden
                className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
              >
                Delegating to <b>{name}</b>
              </span>
            )}
          </span>
          {isA2A && (
            <span className="border-sky-500/30 bg-sky-500/10 text-sky-700 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide dark:text-sky-300">
              <NetworkIcon className="size-2.5" />
              A2A
            </span>
          )}
        </span>
        <ChevronDownIcon className="text-muted-foreground ms-auto size-4 shrink-0 transition-transform group-data-[state=closed]/agent:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="flex flex-col gap-1.5 px-3 pb-2.5">
          {isA2A && (
            <div className="border-sky-500/20 bg-sky-500/5 text-muted-foreground flex items-center gap-2 rounded-md border px-2 py-1.5 font-mono text-[10px]">
              <span className="text-sky-700 font-semibold dark:text-sky-300">
                External agent
              </span>
              <span aria-hidden>·</span>
              <span>{running ? "streaming over A2A" : "remote task complete"}</span>
            </div>
          )}
          {prompt && (
            <div className="text-muted-foreground/80 text-xs italic">
              “{prompt}”
            </div>
          )}
          {toolCalls.length > 0 && (
            <div className="flex flex-col">
              {toolCalls.map((call) => (
                <SubagentToolRow
                  key={call.toolCallId}
                  call={call}
                  result={resultsByCallId.get(call.toolCallId)}
                />
              ))}
            </div>
          )}
          {/* Nested (multi-level) delegations: this subagent itself delegated
              to another agent. Render each child recursively, indented. */}
          {nestedAgents.map((child, i) => {
            const childPrompt = (child as SubagentData & { _childPrompt?: string })
              ._childPrompt;
            return (
              <div
                key={(child.id || "child") + i}
                className="border-border/50 ms-1 border-s ps-2"
              >
                <SubagentCard data={child} prompt={childPrompt} depth={depth + 1} />
              </div>
            );
          })}
          {data.text && (
            <div className="text-muted-foreground border-border/60 border-s ps-3 text-sm whitespace-pre-wrap">
              {data.text}
            </div>
          )}
          {footer}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const SubagentActivity = memo(({ data }: { data: SubagentData }) => {
  // Live progress is this part's only job. Once the delegation is over, the
  // `agent-*` tool-call part in the same message carries the full delegation
  // summary (`text` + `subAgentToolResults`) and renders it via
  // `AgentDelegationSummary` — the same card used when history is restored
  // after a refresh. Rendering this data part too would show the delegation
  // twice. Worse, on the approve-and-resume leg the buffered state is rebuilt
  // from scratch with an empty agent `id` and no pre-suspend tool calls, so
  // the duplicate also has a wrong (inferred) name and missing rows.
  //
  // "Over" is detected two ways because the buffer isn't always reliable:
  // 1. the buffered status flipped to "finished", or
  // 2. the whole assistant message stopped generating ("running" ends;
  //    "requires-action" still counts as live so the card keeps framing a
  //    pending approval). A delegation whose stream errors mid-run never gets
  //    a "finished" chunk and would otherwise spin forever.
  const messageIsLive = useAuiState(
    (s) =>
      s.message.status?.type === "running" ||
      s.message.status?.type === "requires-action",
  );
  if (data.status === "finished" || !messageIsLive) return null;
  return <SubagentCard data={data} depth={0} />;
});

/**
 * Registers a renderer for the `data-tool-agent` parts that Mastra streams
 * during supervisor → subagent delegation. assistant-ui strips the `data-`
 * prefix, so the registered name is `tool-agent`.
 *
 * Render this component anywhere inside the runtime provider; it registers the
 * renderer on mount and renders nothing itself. `thread.tsx` already routes
 * `case "data": return part.dataRendererUI`, so no thread changes are needed.
 */
export const SubagentActivityUI = makeAssistantDataUI<SubagentData>({
  name: "tool-agent",
  render: SubagentActivity,
});
