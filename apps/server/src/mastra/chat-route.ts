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
    type ApprovalPart = {
      toolCallId: string;
      approval: { id: string };
      state: 'approval-responded';
    };
    const asApprovalPart = (part: unknown): ApprovalPart | undefined =>
      typeof part === 'object' &&
      part !== null &&
      'state' in part &&
      (part as { state: string }).state === 'approval-responded' &&
      'approval' in part &&
      'toolCallId' in part
        ? (part as ApprovalPart)
        : undefined;

    // Multiple approval-responded parts can be present at once (parallel tool
    // approvals, or a stale approval left over from a previous auto-send).
    // Rewrite every one that still matches a suspended tool call; skip the
    // rest so a stale approval-responded part can't re-trigger an already
    // resumed run.
    const approvalParts: ApprovalPart[] =
      lastMessage?.role === 'assistant'
        ? lastMessage.parts.flatMap((part) => {
            const approval = asApprovalPart(part);
            return approval ? [approval] : [];
          })
        : [];

    if (approvalParts.length > 0) {
      const thread = body.memory?.thread;
      const threadId = typeof thread === 'string' ? thread : thread?.id;
      const resourceId = body.memory?.resource;
      const agent = mastra.getAgentById(agentId);

      if (!threadId || !resourceId) {
        return c.json({ error: 'Missing thread or resource for approval resume.' }, 400);
      }

      // Fast path: a run still suspended in this process. Storage-backed
      // fallback survives refresh/restart and multi-instance deployments.
      const activeRunId = agent.getActiveThreadRunId({ threadId, resourceId });
      const { runs: suspendedRuns } = await agent.listSuspendedRuns({
        threadId,
        resourceId,
      });

      // Build a map from toolCallId → runId across every currently-suspended
      // run. Tool-call IDs are unique per run, so this disambiguates parallel
      // approvals cleanly.
      const runIdByToolCallId = new Map<string, string>();
      for (const run of suspendedRuns) {
        for (const tc of run.toolCalls) {
          if (tc.toolCallId) runIdByToolCallId.set(tc.toolCallId, run.runId);
        }
      }

      let matched = 0;
      for (const part of approvalParts) {
        const runId =
          runIdByToolCallId.get(part.toolCallId) ??
          // Fall back to the in-process active run when storage hasn't caught
          // up yet (e.g. the run suspended in this process a moment ago).
          activeRunId;
        if (!runId) {
          // Stale part: its run already resumed. Leave it alone; the agent
          // loop will ignore it because the toolCallId is no longer pending.
          continue;
        }
        part.approval.id = `${runId}::${part.toolCallId}`;
        matched++;
      }

      if (matched === 0) {
        return c.json(
          { error: 'No suspended run found for these approvals. The run may have already completed.' },
          409,
        );
      }
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
