import { createTool } from '@mastra/core/tools';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const publishTool = createTool({
  id: 'publish-article',
  description:
    'Publish a finished article. This is a destructive, user-visible action and requires human approval.',
  inputSchema: z.object({
    title: z.string().describe('The article title'),
    content: z.string().describe('The full article body in markdown'),
  }),
  outputSchema: z.object({
    slug: z.string(),
    path: z.string(),
  }),
  requireApproval: true,
  execute: async ({ title, content }) => {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const dir = path.join(process.cwd(), 'published');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${slug}.md`);
    await writeFile(filePath, `# ${title}\n\n${content}\n`);
    return { slug, path: filePath };
  },
});
