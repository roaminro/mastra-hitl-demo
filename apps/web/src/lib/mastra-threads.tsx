import { useMemo, useState, type FC, type PropsWithChildren } from "react";
import {
  RuntimeAdapterProvider,
  useAuiState,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { MastraClient } from "@mastra/client-js";
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type { UIMessage } from "ai";

export const MASTRA_URL =
  import.meta.env.VITE_MASTRA_URL ?? "http://localhost:4111";

/** Agents the user can chat with from the sidebar selector. */
export const AGENTS = [
  { id: "support-agent", label: "Support copilot" },
  { id: "tools-agent", label: "Tool search demo" },
  { id: "routing-agent", label: "Model routing demo" },
  { id: "codemode-agent", label: "Code mode demo" },
] as const;

export const DEFAULT_AGENT_ID = AGENTS[0].id;

// Thread list, titles, and history are scoped by RESOURCE_ID (not by agent) in
// Mastra storage, so a single agentId owns the shared thread management calls
// regardless of which agent is currently answering.
export const AGENT_ID = DEFAULT_AGENT_ID;
// Demo identity: one resource per support rep, one Mastra thread per ticket.
export const RESOURCE_ID = "rep_001";

const client = new MastraClient({ baseUrl: MASTRA_URL });

/**
 * Maps assistant-ui local thread IDs (`__LOCALID_…`) to the Mastra thread IDs
 * we mint in `initialize`. The chat transport consults this map to send the
 * right `memory.thread` to the server. Threads loaded from Mastra use their
 * remote ID as the local ID, so lookups for them fall through to identity.
 */
const localToRemoteThreadId = new Map<string, string>();

export const resolveMastraThreadId = (localOrRemoteId: string) =>
  localToRemoteThreadId.get(localOrRemoteId) ?? localOrRemoteId;

type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter["list"]>
>["threads"][number];

type MastraThread = {
  id: string;
  title?: string | null;
  resourceId: string;
  createdAt: Date | string;
  metadata?: Record<string, unknown> | null;
};

const toMetadata = (t: MastraThread): RemoteThreadMetadata => ({
  status: t.metadata?.archived === true ? "archived" : "regular",
  remoteId: t.id,
  title: t.title || undefined,
});

const updateThread = async (
  remoteId: string,
  updates: { title?: string; metadata?: Record<string, unknown> },
) => {
  const thread = client.getMemoryThread({
    threadId: remoteId,
    agentId: AGENT_ID,
  });
  const current = await thread.get();
  await thread.update({
    title: updates.title ?? current.title ?? "",
    metadata: updates.metadata ?? current.metadata ?? {},
    resourceId: current.resourceId ?? RESOURCE_ID,
  });
};

/** Builds a one-shot AssistantStream that emits `text` as a single text part. */
const textStream = (text: string) =>
  new ReadableStream({
    start(c) {
      c.enqueue({ type: "part-start", part: { type: "text" }, path: [0] });
      c.enqueue({ type: "text-delta", textDelta: text, path: [0] });
      c.enqueue({ type: "part-finish", path: [0] });
      c.close();
    },
  });

/* ------------------------------------------------------------------ */
/* History: load past messages of a thread from Mastra memory          */
/* ------------------------------------------------------------------ */

/** Minimal view of a persisted Mastra message — just what we need to detect
 *  pending tool approvals that the v6 converter doesn't re-express as an
 *  `approval-requested` tool part (see `restoreApprovals`). */
type MastraMessage = {
  id: string;
  role: string;
  content?: {
    metadata?: {
      pendingToolApprovals?: Record<string, { toolCallId?: string }>;
    } | null;
  } | null;
};

/**
 * Collects the toolCallIds that are still awaiting approval across a thread's
 * persisted messages. Mastra stores these in message `content.metadata.
 * pendingToolApprovals`.
 */
const collectPendingApprovalToolCallIds = (raw: MastraMessage[]): Set<string> => {
  const ids = new Set<string>();
  for (const msg of raw) {
    const pending = msg.content?.metadata?.pendingToolApprovals;
    if (!pending) continue;
    for (const entry of Object.values(pending)) {
      if (entry?.toolCallId) ids.add(entry.toolCallId);
    }
  }
  return ids;
};

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/**
 * The framework converter (`toAISdkMessages`) re-expresses a suspended approval
 * as a separate `data-tool-call-approval` *data part* rather than putting the
 * `agent-*` tool call into `approval-requested` state. Assistant UI's
 * `ToolFallback` only renders Allow/Deny from a tool part with an `approval`
 * object, so we upgrade any tool part whose id is still pending into
 * `approval-requested` here.
 *
 * The approval id's run-ID half is a placeholder — the server's chat route
 * rewrites it to the thread's active suspended run before resuming (see
 * apps/server/src/mastra/chat-route.ts).
 */
const restoreApprovals = (
  messages: UIMessage[],
  pendingIds: Set<string>,
): UIMessage[] => {
  if (pendingIds.size === 0) return messages;
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      const toolPart = part as Partial<ToolPart>;
      if (
        typeof toolPart.toolCallId === "string" &&
        pendingIds.has(toolPart.toolCallId) &&
        toolPart.state !== "output-available"
      ) {
        return {
          ...part,
          state: "approval-requested",
          approval: { id: `pending-run::${toolPart.toolCallId}` },
        } as UIMessage["parts"][number];
      }
      return part;
    }),
  }));
};

/**
 * Converts persisted Mastra messages to AI SDK v6 UI messages using the
 * framework's own serializer, then layers the approval-restore patch on top.
 */
const toUIMessages = (raw: MastraMessage[]): UIMessage[] => {
  const pendingIds = collectPendingApprovalToolCallIds(raw);
  const converted = toAISdkMessages(
    raw as never,
    { version: "v6" },
  ) as UIMessage[];
  return restoreApprovals(converted, pendingIds);
};

const createHistoryAdapter = (remoteId: string): ThreadHistoryAdapter => ({
  async load() {
    return { messages: [] };
  },
  async append() {
    // Mastra persists messages server-side via agent memory; nothing to do.
  },
  withFormat(formatAdapter) {
    return {
      async load() {
        const { messages } = await client
          .getMemoryThread({ threadId: remoteId, agentId: AGENT_ID })
          .listMessages();
        const uiMessages = toUIMessages(
          messages as unknown as MastraMessage[],
        );

        let parentId: string | null = null;
        const items = uiMessages.map((message) => {
          const item = { parentId, message: message as never };
          parentId = formatAdapter.getId(message as never);
          return item;
        });
        return { messages: items };
      },
      async append() {
        // Mastra persists messages server-side via agent memory.
      },
    };
  },
});

const HistoryProvider: FC<PropsWithChildren> = ({ children }) => {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  // Freeze the remoteId present when the thread mounts: threads loaded from
  // Mastra have one (→ load history); brand-new threads get theirs mid-run
  // (→ no history to load, and loading then would clobber the live stream).
  const [initialRemoteId] = useState(remoteId);
  const adapters = useMemo(
    () =>
      initialRemoteId
        ? { history: createHistoryAdapter(initialRemoteId) }
        : undefined,
    [initialRemoteId],
  );
  if (!adapters) return children;
  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
};

/* ------------------------------------------------------------------ */
/* Thread list adapter backed by Mastra memory                         */
/* ------------------------------------------------------------------ */

export const mastraThreadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const { threads } = await client.listMemoryThreads({
      resourceId: RESOURCE_ID,
      agentId: AGENT_ID,
    });
    const own = (threads as MastraThread[])
      // Subagent temp threads live under suffixed resource IDs; keep only
      // the rep's own conversation threads.
      .filter((t) => t.resourceId === RESOURCE_ID)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    return { threads: own.map(toMetadata) };
  },

  async initialize(threadId) {
    const remoteId = `web-${crypto.randomUUID()}`;
    localToRemoteThreadId.set(threadId, remoteId);
    // Mastra creates the thread lazily on the first agent call.
    return { remoteId, externalId: undefined };
  },

  async fetch(threadId) {
    const thread = await client
      .getMemoryThread({ threadId, agentId: AGENT_ID })
      .get();
    return toMetadata(thread as MastraThread);
  },

  async rename(remoteId, newTitle) {
    await updateThread(remoteId, { title: newTitle });
  },

  async archive(remoteId) {
    await updateThread(remoteId, { metadata: { archived: true } });
  },

  async unarchive(remoteId) {
    await updateThread(remoteId, { metadata: { archived: false } });
  },

  async delete(remoteId) {
    await client
      .getMemoryThread({ threadId: remoteId, agentId: AGENT_ID })
      .delete();
  },

  async generateTitle(remoteId, messages) {
    const firstUser = messages.find((m) => m.role === "user");
    const text =
      firstUser?.content.find((p) => p.type === "text")?.text ?? "New ticket";
    const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    // Persist so the title survives a refresh; failures only affect the label.
    updateThread(remoteId, { title }).catch(() => {});
    return textStream(title) as never;
  },

  unstable_Provider: HistoryProvider,
};
