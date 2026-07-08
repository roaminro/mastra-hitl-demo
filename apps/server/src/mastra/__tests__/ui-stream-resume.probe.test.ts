import { describe, it, expect } from 'vitest';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { MockLanguageModelV3 } from 'ai/test';
import { handleChatStream } from '@mastra/ai-sdk';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

/**
 * PROBE (local mastra packages): duplicate "Delegated to X" card in the live
 * UI after a tool approval.
 *
 * Symptom in the web app: a delegation whose inner tool requires approval
 * renders ONE card while running, but after Allow the finished state shows
 * TWO cards — the original (correct name) plus a second one with the wrong
 * name. The second card's name comes from `resolveAgentName`'s tool-based
 * fallback, which only triggers when `data.id` (the subagent name) is EMPTY.
 * After a refresh only one card remains, so the duplicate is live-only.
 *
 * Hypothesis: the approval-resume stream emits `data-tool-agent` chunks keyed
 * by a DIFFERENT part id (new runId) with an empty buffered `id`, so
 * assistant-ui appends a second data part instead of updating the first.
 *
 * This probe drives handleChatStream twice (initial turn -> approval-responded
 * turn, the same native-v6 path the web app uses) and prints the part ids +
 * buffered `data.id` for both streams.
 */

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
  totalTokens: 20,
} as const;

type Part = Record<string, any>;

function streamOf(chunks: Part[]): any {
  return {
    stream: new ReadableStream<any>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
  };
}

function textStep(id: string, text: string): Part[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id, modelId: 'mock', timestamp: new Date(0) },
    { type: 'text-start', id: `t-${id}` },
    { type: 'text-delta', id: `t-${id}`, delta: text },
    { type: 'text-end', id: `t-${id}` },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
  ];
}

function toolCallStep(responseId: string, calls: { toolCallId: string; toolName: string; input: unknown }[]): Part[] {
  const parts: Part[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: responseId, modelId: 'mock', timestamp: new Date(0) },
  ];
  for (const c of calls) {
    parts.push({ type: 'tool-input-start', id: c.toolCallId, toolName: c.toolName });
    parts.push({ type: 'tool-input-delta', id: c.toolCallId, delta: JSON.stringify(c.input) });
    parts.push({ type: 'tool-input-end', id: c.toolCallId });
    parts.push({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.stringify(c.input) });
  }
  parts.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE });
  return parts;
}

function buildAgents() {
  const lookupCustomerTool = createTool({
    id: 'lookup-customer',
    description: 'Look up a customer.',
    inputSchema: z.object({ email: z.string() }),
    outputSchema: z.object({ customerId: z.string() }),
    execute: async () => ({ customerId: 'cus_dana' }),
  });

  const sendEmailTool = createTool({
    id: 'send-email',
    description: 'Send an email. Requires approval.',
    inputSchema: z.object({ to: z.string() }),
    outputSchema: z.object({ sent: z.boolean(), id: z.string() }),
    requireApproval: true,
    execute: async () => ({ sent: true, id: 'ntf_1' }),
  });

  const notifications = new Agent({
    id: 'notificationsAgent',
    name: 'Notifications',
    description: 'Sends notifications.',
    instructions: 'Look up the customer, send the email with send-email, then confirm.',
    model: new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const text = JSON.stringify(prompt);
        // Step 3: email sent -> final text.
        if (text.includes('"sent"')) {
          return streamOf(textStep('ntf-final', 'ntf_1 sent to dana@example.com.'));
        }
        // Step 2: customer looked up -> send the email (suspends for approval).
        if (text.includes('"customerId"')) {
          return streamOf(
            toolCallStep('ntf-2', [
              { toolCallId: 'tc-send', toolName: 'send-email', input: { to: 'dana@example.com' } },
            ]),
          );
        }
        // Step 1: look up the customer first.
        return streamOf(
          toolCallStep('ntf-1', [
            { toolCallId: 'tc-lookup', toolName: 'lookup-customer', input: { email: 'dana@example.com' } },
          ]),
        );
      },
    }),
    tools: { lookupCustomerTool, sendEmailTool },
  });

  let supStep = 0;
  const supervisor = new Agent({
    id: 'supervisorAgent',
    name: 'Supervisor',
    description: 'Delegates everything to notifications.',
    instructions: 'Delegate to notifications.',
    model: new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const delegated = JSON.stringify(prompt).includes('ntf_1 sent');
        if (delegated) return streamOf(textStep('sup-final', 'Test email sent to Dana.'));
        supStep += 1;
        return streamOf(
          toolCallStep(`sup-${supStep}`, [
            {
              toolCallId: 'tc-sup-ntf',
              toolName: 'agent-notificationsAgent',
              input: { prompt: 'Send a test email to dana@example.com', maxSteps: 5 },
            },
          ]),
        );
      },
    }),
    agents: { notificationsAgent: notifications },
    // The real supervisor has memory; the resume path differs with memory
    // (sub-agent thread injection etc.), so mirror that here.
    memory: new Memory({
      storage: new LibSQLStore({ id: 'probe-mem', url: ':memory:' }),
    }),
  });

  return supervisor;
}

async function drain(stream: ReadableStream<any>) {
  const chunks: any[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function summarizeAgentParts(label: string, chunks: any[]) {
  const agentParts = chunks.filter((c) => c.type === 'data-tool-agent');
  const byId = new Map<string, { statuses: Set<string>; dataIds: Set<string>; last?: any }>();
  for (const p of agentParts) {
    const entry = byId.get(p.id) ?? { statuses: new Set(), dataIds: new Set() };
    entry.statuses.add(String(p.data?.status));
    entry.dataIds.add(String(p.data?.id ?? ''));
    entry.last = p.data;
    byId.set(p.id, entry);
  }
  console.log(
    `${label} data-tool-agent parts:`,
    JSON.stringify(
      [...byId.entries()].map(([id, e]) => ({
        partId: id,
        bufferedAgentId: [...e.dataIds],
        statuses: [...e.statuses],
        finalBuffer: {
          text: e.last?.text,
          toolCalls: (e.last?.toolCalls ?? []).map((c: any) => c.toolName),
          toolResults: (e.last?.toolResults ?? []).map((r: any) => r.toolName),
          steps: (e.last?.steps ?? []).map((s: any) => ({
            calls: (s.toolCalls ?? []).map((c: any) => c.toolName),
            results: (s.toolResults ?? []).map((r: any) => r.toolName),
          })),
          responseMessages: e.last?.response?.messages?.length ?? 0,
        },
      })),
      null,
      2,
    ),
  );
  return byId;
}

describe('approval-resume UI stream (local packages)', () => {
  it('checks whether the resume stream re-keys the data-tool-agent part', async () => {
    const supervisor = buildAgents();
    const mastra = new Mastra({ agents: { supervisorAgent: supervisor } });

    // ---- Turn 1: normal message; delegation suspends on the approval. ----
    const stream1 = await handleChatStream({
      mastra,
      agentId: 'supervisorAgent',
      version: 'v6',
      params: {
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Send a test email to Dana' }] },
        ] as any,
        memory: { thread: 'thread-1', resource: 'rep_001' },
      } as any,
    });
    const chunks1 = await drain(stream1);
    const parts1 = summarizeAgentParts('TURN 1', chunks1);

    const approvalReq = chunks1.find((c) => c.type === 'tool-approval-request');
    console.log('TURN 1 approval request:', JSON.stringify(approvalReq));
    expect(approvalReq).toBeTruthy();

    // ---- Turn 2: native v6 approval-responded resume. ----
    const stream2 = await handleChatStream({
      mastra,
      agentId: 'supervisorAgent',
      version: 'v6',
      params: {
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Send a test email to Dana' }] },
          {
            id: 'a1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-agent-notificationsAgent',
                toolCallId: 'tc-sup-ntf',
                state: 'approval-responded',
                input: { prompt: 'Send a test email to dana@example.com', maxSteps: 5 },
                approval: { id: approvalReq.approvalId, approved: true },
              },
            ],
          },
        ] as any,
        memory: { thread: 'thread-1', resource: 'rep_001' },
      } as any,
    });
    const chunks2 = await drain(stream2);
    const parts2 = summarizeAgentParts('TURN 2 (resume)', chunks2);

    const outAvail = chunks2.filter((c) => c.type === 'tool-output-available');
    for (const o of outAvail) {
      console.log(
        'TURN 2 tool-output-available:',
        o.toolCallId,
        JSON.stringify(o.output)?.slice(0, 600),
      );
    }

    // The duplicate-card bug: resume emits a data part under a NEW id.
    const ids1 = [...parts1.keys()];
    const ids2 = [...parts2.keys()];
    console.log('PART ID MATCH:', JSON.stringify({ ids1, ids2 }));
  }, 60_000);
});
