import { Agent } from '@mastra/core/agent';

export const researcherAgent = new Agent({
  id: 'researcher-agent',
  name: 'Researcher',
  description:
    'Researches a topic and produces an article outline with supporting bullet-point notes.',
  instructions: `You are a research assistant for a content team.

Given a topic, produce:
1. A clear article outline (titled sections in reading order).
2. Concise bullet-point research notes per section: key facts, angles, and examples.

Stay factual and note any uncertainty. Do not write the article itself.`,
  model: 'openrouter/openai/gpt-5.4-mini',
});
