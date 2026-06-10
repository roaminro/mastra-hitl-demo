import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import {
  AGENT_ID,
  MASTRA_URL,
  RESOURCE_ID,
  mastraThreadListAdapter,
  resolveMastraThreadId,
} from "@/lib/mastra-threads";

const transport = new AssistantChatTransport({
  api: `${MASTRA_URL}/chat/${AGENT_ID}`,
  prepareSendMessagesRequest: (options) => ({
    body: {
      ...options.body,
      id: options.id,
      messages: options.messages,
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

const useMastraRuntime = () =>
  useRemoteThreadListRuntime({
    runtimeHook: function RuntimeHook() {
      // Nested inside useRemoteThreadListRuntime, this acts as a plain
      // per-thread chat runtime (allowNesting).
      return useChatRuntime({
        transport,
        // Auto-send the follow-up request after the user approves/denies a tool call.
        sendAutomaticallyWhen:
          lastAssistantMessageIsCompleteWithApprovalResponses,
      });
    },
    adapter: mastraThreadListAdapter,
  });

export const Assistant = () => {
  const runtime = useMastraRuntime();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-dvh overflow-hidden">
        <aside className="border-border bg-muted/30 flex w-[260px] shrink-0 flex-col gap-2 overflow-y-auto border-r p-3">
          <div className="text-muted-foreground px-2 pt-1 text-xs font-semibold tracking-wide uppercase">
            Tickets
          </div>
          <ThreadList />
        </aside>
        <main className="h-full min-w-0 flex-1">
          <Thread />
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
};
