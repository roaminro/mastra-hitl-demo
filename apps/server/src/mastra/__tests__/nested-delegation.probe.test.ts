import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * PROBE: how does a *nested* (multi-level) delegation surface in the agent
 * stream that @mastra/ai-sdk turns into UI `data-tool-agent` parts?
 *
 * Chain: supervisor -> coordinator (tier1) -> researcher (tier2, leaf w/ tool).
 *
 * The ai-sdk transform builds `data-tool-agent` parts from `tool-output`
 * chunks whose `output.from === 'AGENT'` (see @mastra/ai-sdk dist: the
 * "tool-output" case maps to type "tool-agent", keyed by the subagent runId).
 * So we inspect the supervisor's `fullStream` and record, for every AGENT
 * tool-output, the runId and the subagent name carried in the payload.
 *
 * Question this answers: does the tier1->tier2 delegation produce its OWN
 * distinct AGENT runId on the top-level stream (=> UI can show it as a
 * separate card), or is tier2 only visible folded inside tier1's buffered
 * text/steps (=> UI must dig into the parent buffer to reveal nesting)?
 *
 * Skips without OPENROUTER_API_KEY.
 */

const hasKey = !!process.env.OPENROUTER_API_KEY;
const d = hasKey ? describe : describe.skip;

const leafTool = createTool({
  id: 'fetch-fact',
  description: 'Returns a canned fact for a topic.',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ fact: z.string() }),
  execute: async ({ topic }) => ({
    fact: `FACT(${topic}): the sky is blue because of Rayleigh scattering.`,
  }),
});

function buildChain() {
  const researcher = new Agent({
    id: 'tier2-researcher',
    name: 'Researcher',
    description: 'Leaf researcher. Looks up a fact for a topic using its tool.',
    instructions:
      'Look up a fact for the requested topic using the fetch-fact tool, then report it in one sentence. Do not delegate.',
    model: 'openrouter/openai/gpt-5.4-mini',
    tools: { leafTool },
  });

  const coordinator = new Agent({
    id: 'tier1-coordinator',
    name: 'Coordinator',
    description:
      'Mid-level coordinator. Delegates research to the researcher and summarizes.',
    instructions:
      'When asked to research a topic, delegate to the researcher to fetch the fact, then summarize what it returned in one sentence. Always delegate; never answer from your own knowledge and never use a tool yourself.',
    model: 'openrouter/openai/gpt-5.4-mini',
    agents: { researcher },
  });

  const supervisor = new Agent({
    id: 'nested-supervisor',
    name: 'Supervisor',
    description: 'Top-level supervisor. Delegates everything to the coordinator.',
    instructions:
      'When asked anything, delegate to the coordinator. Do not answer directly and do not use any tools yourself.',
    model: 'openrouter/openai/gpt-5.4-mini',
    agents: { coordinator },
  });

  return { supervisor };
}

interface AgentOut {
  runId: string;
  name: string;
  status: string;
  nested?: boolean;
}

d('nested (multi-level) delegation stream shape (REAL LLM)', () => {
  it('shows whether tier2 delegation surfaces as its own top-level AGENT run', async () => {
    const { supervisor } = buildChain();

    const stream = await supervisor.stream('Research why the sky is blue.', {
      maxSteps: 10,
    });

    const chunkTypes: Record<string, number> = {};
    const agentOutputs: AgentOut[] = [];
    const namesByRun = new Map<string, string>();
    // The most-complete AGENT payload — reveals where nested tier2 lives.
    let lastAgentPayload: any;
    // All tool names referenced anywhere in the coordinator's buffered output.
    const nestedToolNames = new Set<string>();

    const scanForToolNames = (obj: any, depth = 0) => {
      if (!obj || depth > 6) return;
      if (Array.isArray(obj)) {
        for (const v of obj) scanForToolNames(v, depth + 1);
        return;
      }
      if (typeof obj === 'object') {
        if (typeof obj.toolName === 'string') nestedToolNames.add(obj.toolName);
        for (const v of Object.values(obj)) scanForToolNames(v, depth + 1);
      }
    };

    for await (const chunk of stream.fullStream) {
      chunkTypes[chunk.type] = (chunkTypes[chunk.type] ?? 0) + 1;
      if (chunk.type === 'tool-output') {
        const out: any = (chunk as any).payload?.output ?? (chunk as any).output;
        if (out?.from === 'AGENT') {
          const runId = String(out.runId ?? out.payload?.runId ?? '');
          const name = String(
            out.id ?? out.payload?.id ?? out.agentId ?? out.payload?.agentId ?? '',
          );
          if (runId && name && !namesByRun.has(runId)) namesByRun.set(runId, name);
          agentOutputs.push({
            runId,
            name,
            status: String(out.status ?? out.payload?.status ?? ''),
            nested: out.isNested ?? out.payload?.isNested,
          });
          lastAgentPayload = out.payload ?? out;
          scanForToolNames(out.payload ?? out);
        }
      }
    }

    const distinctRuns = new Set(agentOutputs.map((a) => a.runId).filter(Boolean));
    const distinctNames = new Set([...namesByRun.values()]);

    // eslint-disable-next-line no-console
    console.log('NESTED PROBE tool names found in coordinator buffer:', [...nestedToolNames]);
    // eslint-disable-next-line no-console
    console.log(
      'NESTED PROBE last agent payload keys:',
      lastAgentPayload ? Object.keys(lastAgentPayload) : 'none',
    );

    // Show how the nested agent-researcher call + its result are shaped inside
    // the coordinator's buffered response, so the UI knows how to extract the
    // child delegation for a nested card.
    const findAgentParts = (obj: any, depth = 0, acc: any[] = []): any[] => {
      if (!obj || depth > 7) return acc;
      if (Array.isArray(obj)) {
        for (const v of obj) findAgentParts(v, depth + 1, acc);
        return acc;
      }
      if (typeof obj === 'object') {
        const tn = obj.toolName;
        if (typeof tn === 'string' && tn.startsWith('agent-')) {
          acc.push({
            keys: Object.keys(obj),
            toolName: tn,
            type: obj.type,
            hasOutput: 'output' in obj || 'result' in obj,
          });
        }
        for (const v of Object.values(obj)) findAgentParts(v, depth + 1, acc);
      }
      return acc;
    };
    // eslint-disable-next-line no-console
    console.log(
      'NESTED PROBE nested agent-* parts in coordinator buffer:',
      JSON.stringify(findAgentParts(lastAgentPayload).slice(0, 4), null, 2),
    );

    // eslint-disable-next-line no-console
    console.log('NESTED PROBE chunk types:', JSON.stringify(chunkTypes));
    // eslint-disable-next-line no-console
    console.log('NESTED PROBE distinct AGENT runIds:', distinctRuns.size, [...distinctRuns]);
    // eslint-disable-next-line no-console
    console.log('NESTED PROBE names by run:', JSON.stringify([...namesByRun.entries()], null, 2));
    // eslint-disable-next-line no-console
    console.log('NESTED PROBE distinct subagent names:', [...distinctNames]);
    // eslint-disable-next-line no-console
    console.log(
      'NESTED PROBE sample AGENT outputs:',
      JSON.stringify(agentOutputs.slice(0, 6), null, 2),
    );

    // The supervisor->coordinator delegation must at least surface.
    expect(distinctRuns.size).toBeGreaterThanOrEqual(1);
  });
});
