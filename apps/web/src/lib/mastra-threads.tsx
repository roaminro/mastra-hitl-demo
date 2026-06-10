import { useMemo, useState, type FC, type PropsWithChildren } from "react";
import {
  RuntimeAdapterProvider,
  useAuiState,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { MastraClient } from "@mastra/client-js";
import type { UIMessage } from "ai";

export const MASTRA_URL =
  import.meta.env.VITE_MASTRA_URL ?? "http://localhost:4111";
export const AGENT_ID = "support-agent";
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

type MastraMessagePart = {
  type: string;
  text?: string;
  toolInvocation?: {
    state: string;
    toolCallId: string;
    toolName: string;
    args?: unknown;
    result?: unknown;
  };
};

type MastraMessage = {
  id: string;
  role: string;
  content: { parts?: MastraMessagePart[] };
};

const toUIMessage = (msg: MastraMessage): UIMessage | null => {
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  const parts: UIMessage["parts"] = [];
  for (const part of msg.content.parts ?? []) {
    if (part.type === "text" && part.text) {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "tool-invocation" && part.toolInvocation) {
      const ti = part.toolInvocation;
      parts.push(
        ti.state === "result"
          ? {
              type: "dynamic-tool",
              toolName: ti.toolName,
              toolCallId: ti.toolCallId,
              state: "output-available",
              input: ti.args ?? {},
              output: ti.result,
            }
          : {
              type: "dynamic-tool",
              toolName: ti.toolName,
              toolCallId: ti.toolCallId,
              state: "input-available",
              input: ti.args ?? {},
            },
      );
    }
    // reasoning, step-start, data-om-* parts are not useful to restore
  }
  if (parts.length === 0) return null;
  return { id: msg.id, role: msg.role as UIMessage["role"], parts };
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
        const uiMessages = (messages as unknown as MastraMessage[])
          .map(toUIMessage)
          .filter((m): m is UIMessage => m !== null);

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
