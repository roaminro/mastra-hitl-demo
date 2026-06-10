
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, MastraStorageExporter, MastraPlatformExporter, SensitiveDataFilter } from '@mastra/observability';
import { chatRoute } from '@mastra/ai-sdk';
import { researcherAgent } from './agents/researcher-agent';
import { writerAgent } from './agents/writer-agent';
import { publisherAgent } from './agents/publisher-agent';
import { editorAgent } from './agents/editor-agent';
import { accountAgent } from './agents/account-agent';
import { billingAgent } from './agents/billing-agent';
import { supportAgent } from './agents/support-agent';

export const mastra = new Mastra({
  agents: {
    researcherAgent,
    writerAgent,
    publisherAgent,
    editorAgent,
    accountAgent,
    billingAgent,
    supportAgent,
  },
  server: {
    apiRoutes: [
      chatRoute({
        path: '/chat/:agentId',
        version: 'v6',
      }),
    ],
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: "mastra-storage",
      url: "file:./mastra.db",
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    }
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
