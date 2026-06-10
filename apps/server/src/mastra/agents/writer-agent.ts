import { Agent } from '@mastra/core/agent';

export const writerAgent = new Agent({
  id: 'writer-agent',
  name: 'Writer',
  description:
    'Turns an approved outline and research notes into a polished markdown article.',
  instructions: `You are a writer for a content team.

You receive an outline, research notes, and optionally reviewer feedback.
Write a complete, well-structured markdown article that follows the outline
and incorporates the feedback. Use clear headings, full paragraphs, and a
concise, engaging tone. Return only the article markdown.`,
  model: 'openrouter/openai/gpt-5.4-mini',
});
