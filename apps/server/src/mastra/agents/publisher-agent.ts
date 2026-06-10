import { Agent } from '@mastra/core/agent';
import { publishTool } from '../tools/publish-tool';

export const publisherAgent = new Agent({
  id: 'publisher-agent',
  name: 'Publisher',
  description:
    'Publishes finished articles using the publish-article tool. Publishing requires human approval.',
  instructions: `You are the publisher for a content team.

You receive a finished article (title and markdown body). Use the
publish-article tool to publish it. Publishing requires human approval —
if the publish call is declined, report back that publication was rejected
instead of retrying. After a successful publish, report the slug and path.`,
  model: 'openrouter/openai/gpt-5.4-mini',
  tools: { publishTool },
});
