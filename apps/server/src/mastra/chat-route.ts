import { registerApiRoute } from '@mastra/core/server';
import { handleChatStream } from '@mastra/ai-sdk';
import { createUIMessageStreamResponse } from 'ai';

// Resolves to the v6 overload's options (TS picks the last overload).
type ChatStreamOptionsV6 = Parameters<typeof handleChatStream>[0];
type ChatBody = ChatStreamOptionsV6['params'];

/**
 * Custom chat route that wraps `handleChatStream` to make tool-call
 * approvals survive a page refresh or server restart.
 *
 * The stream's approval IDs embed the agent run ID
 * (`${runId}::${toolCallId}`), but that ID only exists in the live stream —
 * thread messages persist a different (nested subagent) run ID. So when a
 * client restores a pending approval from history and responds to it, the
 * embedded run ID is wrong. Before delegating to `handleChatStream`, this
 * handler resolves the thread's currently-suspended run and rewrites the
 * approval ID, which makes the resume work regardless of where the approval
 * response came from.
 *
 * Run discovery uses the in-memory `getActiveThreadRunId` first (fast path
 * for a run suspended in this process), then falls back to the storage-backed
 * `agent.listSuspendedRuns()` (Mastra 1.48). The fallback survives a server
 * restart and works across instances sharing the same storage; the match is
 * pinned to the approval's `toolCallId` since tool-call IDs are unique to a
 * single run.
 */
export const chatRoute = registerApiRoute('/chat/:agentId', {
  method: 'POST',
  handler: async (c) => {
    const mastra = c.get('mastra');
    const agentId = c.req.param('agentId');
    const body = (await c.req.json()) as ChatBody;

    const lastMessage = body.messages?.at(-1);
    const approvalPart =
      lastMessage?.role === 'assistant'
        ? lastMessage.parts.find(
            (part): part is typeof part & {
              toolCallId: string;
              approval: { id: string };
            } =>
              'state' in part &&
              part.state === 'approval-responded' &&
              'approval' in part,
          )
        : undefined;

    if (approvalPart) {
      const thread = body.memory?.thread;
      const threadId = typeof thread === 'string' ? thread : thread?.id;
      const resourceId = body.memory?.resource;
      const agent = mastra.getAgentById(agentId);

      let runId: string | undefined;
      if (threadId && resourceId) {
        // Fast path: a run still suspended in this process.
        runId = agent.getActiveThreadRunId({ threadId, resourceId });
        // Durable path (survives refresh/restart, multi-instance): storage-backed
        // discovery, matched to this approval's toolCallId.
        if (!runId) {
          const { runs } = await agent.listSuspendedRuns({ threadId, resourceId });
          runId = runs.find((run) =>
            run.toolCalls.some((tc) => tc.toolCallId === approvalPart.toolCallId),
          )?.runId;
        }
      }
      if (!runId) {
        return c.json(
          { error: 'No suspended run found for this thread. The run may have already completed.' },
          409,
        );
      }
      approvalPart.approval.id = `${runId}::${approvalPart.toolCallId}`;
    }

    const stream = await handleChatStream({
      mastra,
      agentId,
      version: 'v6',
      // Stream reasoning so the supervisor's and subagents' thinking is
      // visible live (subagent reasoning surfaces inside `data-tool-agent`).
      sendReasoning: true,
      params: {
        ...body,
        messages: body.messages ?? [],
        abortSignal: c.req.raw.signal,
      },
    });
    return createUIMessageStreamResponse({ stream });
  },
});
