"use client";

import { memo, useState } from "react";
import { CheckIcon, ChevronDownIcon, LoaderIcon, WrenchIcon } from "lucide-react";
import { makeAssistantDataUI } from "@assistant-ui/react";
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

type SubagentData = {
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

/**
 * Collect tool calls/results from the live top-level arrays AND the finalized
 * `steps[]`, so the subagent's tool activity stays visible after completion.
 */
const collectTools = (data: SubagentData) => {
  const calls = new Map<string, SubagentToolCall>();
  const results = new Map<string, SubagentToolResult>();

  const ingest = (
    cs: SubagentToolCall[] = [],
    rs: SubagentToolResult[] = [],
  ) => {
    for (const c of cs) if (c?.toolCallId) calls.set(c.toolCallId, c);
    for (const r of rs) if (r?.toolCallId) results.set(r.toolCallId, r);
  };

  ingest(data.toolCalls, data.toolResults);
  for (const step of data.steps ?? []) ingest(step.toolCalls, step.toolResults);

  return { calls: [...calls.values()], results };
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
const toolToAgent: Record<string, string> = {
  issueRefundTool: "billing-agent",
  listCustomersTool: "account-agent",
  lookupCustomerTool: "account-agent",
};

const resolveAgentName = (data: SubagentData): string => {
  if (data.id) return humanizeAgentName(data.id);
  for (const tn of allToolNames(data)) {
    const agent = toolToAgent[tn];
    if (agent) return humanizeAgentName(agent);
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
              {typeof result.result === "string"
                ? result.result
                : JSON.stringify(result.result, null, 2)}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const SubagentActivityImpl = ({ data }: { data: SubagentData }) => {
  const running = data.status !== "finished";
  // Auto-expand while the subagent is actively working so the rep sees
  // progress; let them collapse it once done.
  const [open, setOpen] = useState(true);

  const name = resolveAgentName(data);
  const { calls: toolCalls, results: resultsByCallId } = collectTools(data);

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
        <span className="relative text-start leading-none">
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
        <ChevronDownIcon className="text-muted-foreground ms-auto size-4 shrink-0 transition-transform group-data-[state=closed]/agent:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="flex flex-col gap-1.5 px-3 pb-2.5">
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
          {data.text && (
            <div className="text-muted-foreground border-border/60 border-s ps-3 text-sm whitespace-pre-wrap">
              {data.text}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const SubagentActivity = memo(SubagentActivityImpl);

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
