import { useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { isToolUIPart, type UIMessage } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { SubagentActivityUI } from "@/components/assistant-ui/subagent-activity";
import { OmActivityUI } from "@/components/assistant-ui/om-activity";
import { ModelRoutingUI } from "@/components/assistant-ui/model-routing";
import { CodeModeToolFallback } from "@/components/assistant-ui/code-mode";
import {
  AGENTS,
  DEFAULT_AGENT_ID,
  MASTRA_URL,
  RESOURCE_ID,
  mastraThreadListAdapter,
  resolveMastraThreadId,
} from "@/lib/mastra-threads";

/**
 * Auto-send the follow-up request once every pending approval has been
 * responded to. Unlike the stock
 * `lastAssistantMessageIsCompleteWithApprovalResponses`, this ignores tool
 * parts without output: messages restored from Mastra memory mid-suspension
 * include earlier tool calls whose results aren't persisted yet, which would
 * otherwise block the auto-send forever.
 */
const allApprovalsResponded = ({ messages }: { messages: UIMessage[] }) => {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;
  const toolParts = last.parts.filter(isToolUIPart);
  return (
    toolParts.some((p) => p.state === "approval-responded") &&
    !toolParts.some((p) => p.state === "approval-requested")
  );
};

/**
 * The chat transport targets `/chat/:agentId`. The thread list and memory are
 * scoped by RESOURCE_ID (not by agent) in Mastra storage, so switching the
 * agent only changes which agent answers — the shared thread list and history
 * are unchanged. The transport is rebuilt whenever the selected agent changes.
 */
const buildTransport = (agentId: string) =>
  new AssistantChatTransport({
    api: `${MASTRA_URL}/chat/${agentId}`,
    prepareSendMessagesRequest: (options) => ({
      body: {
        ...options.body,
        id: options.id,
        // The server owns history via Mastra memory (thread/resource below), so
        // only send the latest message. Sending the full transcript re-persists
        // old rows with fresh part-level `createdAt` timestamps, which corrupts
        // memory-recall ordering (past user turns land after their replies).
        messages: options.messages.slice(-1),
        trigger: options.trigger,
        messageId: options.messageId,
        metadata: options.requestMetadata,
        // Each assistant-ui thread maps to its own Mastra memory thread.
        memory: {
          thread: resolveMastraThreadId(options.id),
          resource: RESOURCE_ID,
        },
      },
    }),
  });

const useMastraRuntime = (agentId: string) =>
  useRemoteThreadListRuntime({
    runtimeHook: function RuntimeHook() {
      // Rebuild the transport when the selected agent changes so the chat
      // route URL follows the selection.
      const transport = useMemo(() => buildTransport(agentId), [agentId]);
      // Nested inside useRemoteThreadListRuntime, this acts as a plain
      // per-thread chat runtime (allowNesting).
      return useChatRuntime({
        transport,
        // Auto-send the follow-up request after the user approves/denies a tool call.
        sendAutomaticallyWhen: allApprovalsResponded,
      });
    },
    adapter: mastraThreadListAdapter,
  });

export const Assistant = () => {
  const [agentId, setAgentId] = useState<string>(DEFAULT_AGENT_ID);
  const runtime = useMastraRuntime(agentId);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Registers the live renderer for Mastra's `data-tool-agent` parts. */}
      <SubagentActivityUI />
      {/* Registers renderers for Mastra's `data-om-*` (Observational Memory) parts. */}
      <OmActivityUI />
      {/* Registers the renderer for the routing-agent's `data-model-routing` parts. */}
      <ModelRoutingUI />
      <div className="flex h-dvh overflow-hidden">
        <aside className="border-border bg-muted/30 flex w-[260px] shrink-0 flex-col gap-2 overflow-y-auto border-r p-3">
          <div className="flex flex-col gap-1 px-2 pt-1">
            <label
              htmlFor="agent-select"
              className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
            >
              Agent
            </label>
            <select
              id="agent-select"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="border-border bg-background focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              {AGENTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="text-muted-foreground px-2 pt-2 text-xs font-semibold tracking-wide uppercase">
            Tickets
          </div>
          <ThreadList />
        </aside>
        <main className="h-full min-w-0 flex-1">
          {/* ToolFallback override renders the codemode-agent's
              `execute_typescript` calls as code + aggregated result. */}
          <Thread components={{ ToolFallback: CodeModeToolFallback }} />
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
};
