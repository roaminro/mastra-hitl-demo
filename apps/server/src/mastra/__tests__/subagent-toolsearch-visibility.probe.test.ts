import { describe, it, expect } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { z } from 'zod';

/**
 * PROBE: if a SUBAGENT owns the ToolSearchProcessor, do its `search_tools` /
 * `load_tool` meta-tool calls leak onto the SUPERVISOR's stream, or are they
 * confined to the subagent (only its final response surfaces up top)?
 *
 * We stream the supervisor's fullStream and split every occurrence of a
 * `search_tools`/`load_tool` tool name into two buckets:
 *   - TOP-LEVEL: it appears as a tool-call/tool-result chunk that is the
 *     supervisor's own step (i.e. NOT inside an AGENT tool-output payload).
 *   - FOLDED:    it appears only inside a subagent AGENT tool-output payload
 *     (i.e. the delegation buffer that the UI renders as a card).
 *
 * Answer we want: TOP-LEVEL count === 0 (supervisor never sees search noise),
 * FOLDED count > 0 (the noise lives inside the subagent buffer only).
 *
 * Skips without OPENROUTER_API_KEY.
 */

const hasKey = !!process.env.OPENROUTER_API_KEY;
const d = hasKey ? describe : describe.skip;

const SEARCH_META = ['search_tools', 'load_tool'];

// A small library the search subagent will discover from.
const lookupPlan = createTool({
  id: 'lookup-plan',
  description: 'Look up the subscription plan for a customer by email.',
  inputSchema: z.object({ email: z.string() }),
  outputSchema: z.object({ plan: z.string() }),
  execute: async ({ email }) => ({ plan: `PLAN(${email}): pro` }),
});
const lookupWeather = createTool({
  id: 'lookup-weather',
  description: 'Get the current weather forecast for a city.',
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ forecast: z.string() }),
  execute: async ({ city }) => ({ forecast: `sunny in ${city}` }),
});
const lookupStock = createTool({
  id: 'lookup-stock',
  description: 'Get the latest stock price for a ticker symbol.',
  inputSchema: z.object({ ticker: z.string() }),
  outputSchema: z.object({ price: z.number() }),
  execute: async ({ ticker }) => ({ price: 123 }),
});

function buildChain() {
  // Subagent OWNS the ToolSearchProcessor. Its only job is to find + use a tool.
  const searcher = new Agent({
    id: 'tool-searcher',
    name: 'Searcher',
    description:
      'Finds and uses the right tool to answer a lookup. Delegate lookups here.',
    instructions:
      'You have search_tools/load_tool. Search for the tool that fits the request, use it, and report the result in one sentence.',
    model: 'openrouter/openai/gpt-5.4-mini',
    inputProcessors: [
      new ToolSearchProcessor({
        tools: { lookupPlan, lookupWeather, lookupStock },
        search: { topK: 3, autoLoad: true },
      }),
    ],
  });

  const supervisor = new Agent({
    id: 'search-supervisor',
    name: 'Supervisor',
    description: 'Delegates every lookup to the searcher subagent.',
    instructions:
      'When asked a lookup question, delegate to the searcher. Do not answer directly and do not use any tools yourself.',
    model: 'openrouter/openai/gpt-5.4-mini',
    agents: { searcher },
  });

  return { supervisor };
}

function nameOf(chunk: any): string | undefined {
  const p = chunk?.payload ?? chunk;
  return p?.toolName ?? p?.toolName;
}

// Recursively count occurrences of the search meta-tool names anywhere in an obj.
function countMetaNames(obj: any, depth = 0): number {
  if (!obj || depth > 8) return 0;
  let n = 0;
  if (Array.isArray(obj)) {
    for (const v of obj) n += countMetaNames(v, depth + 1);
    return n;
  }
  if (typeof obj === 'object') {
    if (typeof obj.toolName === 'string' && SEARCH_META.includes(obj.toolName)) n += 1;
    for (const v of Object.values(obj)) n += countMetaNames(v, depth + 1);
    return n;
  }
  return 0;
}

d('subagent-owned ToolSearchProcessor visibility (REAL LLM)', () => {
  it('keeps search_tools/load_tool off the supervisor stream, folded in the subagent buffer', async () => {
    const { supervisor } = buildChain();

    const stream = await supervisor.stream(
      'What subscription plan is dana@example.com on?',
      { maxSteps: 10 },
    );

    const chunkTypes: Record<string, number> = {};
    let topLevelMeta = 0; // search meta-tool as the supervisor's OWN tool step
    let foldedMeta = 0; // search meta-tool inside an AGENT (subagent) payload
    const topLevelToolNames = new Set<string>();

    for await (const chunk of stream.fullStream) {
      chunkTypes[chunk.type] = (chunkTypes[chunk.type] ?? 0) + 1;

      // A subagent's inner activity arrives as tool-output with from==='AGENT'.
      if (chunk.type === 'tool-output') {
        const out: any = (chunk as any).payload?.output ?? (chunk as any).output;
        if (out?.from === 'AGENT') {
          foldedMeta += countMetaNames(out.payload ?? out);
          continue;
        }
      }

      // Supervisor's OWN tool activity: tool-call / tool-result chunks.
      if (chunk.type === 'tool-call' || chunk.type === 'tool-result') {
        const tn = nameOf(chunk);
        if (typeof tn === 'string') {
          topLevelToolNames.add(tn);
          if (SEARCH_META.includes(tn)) topLevelMeta += 1;
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log('VIS PROBE chunk types:', JSON.stringify(chunkTypes));
    // eslint-disable-next-line no-console
    console.log('VIS PROBE supervisor top-level tool names:', [...topLevelToolNames]);
    // eslint-disable-next-line no-console
    console.log('VIS PROBE top-level search-meta count:', topLevelMeta);
    // eslint-disable-next-line no-console
    console.log('VIS PROBE folded-in-subagent search-meta count:', foldedMeta);

    // The supervisor's own steps must be free of search_tools/load_tool.
    expect(topLevelMeta).toBe(0);
    for (const tn of topLevelToolNames) {
      expect(SEARCH_META).not.toContain(tn);
    }
    // The only top-level tool the supervisor uses is the agent delegation.
    for (const tn of topLevelToolNames) {
      expect(tn.startsWith('agent-')).toBe(true);
    }
  });
});
