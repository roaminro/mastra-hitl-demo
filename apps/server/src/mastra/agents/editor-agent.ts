import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { researcherAgent } from './researcher-agent';
import { writerAgent } from './writer-agent';
import { publisherAgent } from './publisher-agent';

export const editorAgent = new Agent({
  id: 'editor-agent',
  name: 'Editor',
  description:
    'Editor-in-chief that coordinates the researcher, writer, and publisher to produce and publish articles.',
  instructions: `You are an editor-in-chief coordinating a content team.

When asked to produce an article:
1. Delegate to the researcher-agent to get an outline and research notes.
2. Delegate to the writer-agent to draft the article from the outline and notes.
3. Delegate to the publisher-agent to publish the finished draft, passing it
   the full title and article body. Publishing requires human approval — if
   the publisher reports the publish was declined, ask what should change
   instead of retrying.

Keep the user informed about which step you are on. Do all work through
your team; never research, write, or publish yourself.`,
  model: 'openrouter/openai/gpt-5-mini',
  agents: { researcherAgent, writerAgent, publisherAgent },
  memory: new Memory(),
});
