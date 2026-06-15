import { registerApiRoute } from '@mastra/core/server';
import { handleChatStream } from '@mastra/ai-sdk';
import { createUIMessageStreamResponse } from 'ai';

// Resolves to the v6 overload's options (TS picks the last overload).
type ChatStreamOptionsV6 = Parameters<typeof handleChatStream>[0];
type ChatBody = ChatStreamOptionsV6['params'];
type MastraInstance = ChatStreamOptionsV6['mastra'];

type SnapshotStep = {
  status?: string;
  suspendPayload?: {
    requireToolApproval?: { toolCallId?: string };
    __streamState?: { messageList?: { memoryInfo?: { threadId?: string } } };
  };
};

/**
 * Durable fallback for run discovery: `getActiveThreadRunId` only knows
 * about runs suspended in this process, but the suspended run state itself
 * is persisted as an `agentic-loop` workflow snapshot. Find the run whose
 * snapshot matches this thread and pending tool call, so approvals still
 * resume after a server restart (or on a different instance sharing the
 * same storage).
 *
 * Snapshots keep `status: 'suspended'` even after the run completes, so the
 * match is pinned to the `toolCallId` of the approval being responded to —
 * tool call IDs are unique to a single run.
 */
const findSuspendedRunId = async (
  mastra: MastraInstance,
  { threadId, resourceId, toolCallId }: { threadId: string; resourceId: string; toolCallId: string },
): Promise<string | undefined> => {
  const workflowsStore = await mastra.getStorage()?.getStore('workflows');
  if (!workflowsStore) return undefined;
  const { runs } = await workflowsStore.listWorkflowRuns({
    workflowName: 'agentic-loop',
    resourceId,
    status: 'suspended',
  });
  for (const run of runs) {
    const snapshot = (
      typeof run.snapshot === 'string' ? JSON.parse(run.snapshot) : run.snapshot
    ) as { status?: string; context?: Record<string, SnapshotStep> };
    if (snapshot?.status !== 'suspended') continue;
    for (const step of Object.values(snapshot.context ?? {})) {
      if (step?.status !== 'suspended') continue;
      const payload = step.suspendPayload;
      if (
        payload?.__streamState?.messageList?.memoryInfo?.threadId === threadId &&
        payload?.requireToolApproval?.toolCallId === toolCallId
      ) {
        return run.runId;
      }
    }
  }
  return undefined;
};

/**
 * Custom chat route that wraps `handleChatStream` to make tool-call
 * approvals survive a page refresh.
 *
 * The stream's approval IDs embed the agent run ID
 * (`${runId}::${toolCallId}`), but that ID only exists in the live stream —
 * thread messages persist a different (nested subagent) run ID. So when a
 * client restores a pending approval from history and responds to it, the
 * embedded run ID is wrong. Before delegating to `handleChatStream`, this
 * handler rewrites the approval ID using the thread's active (suspended)
 * run, which makes the resume work regardless of where the approval
 * response came from.
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
      const runId =
        threadId && resourceId
          ? (mastra.getAgentById(agentId).getActiveThreadRunId({ threadId, resourceId }) ??
            (await findSuspendedRunId(mastra, {
              threadId,
              resourceId,
              toolCallId: approvalPart.toolCallId,
            })))
          : undefined;
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
