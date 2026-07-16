import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { fulfillmentAgent } from './agents/fulfillment-agent';

export const mastra = new Mastra({
  agents: { fulfillmentAgent },
  server: {
    port: 4112,
  },
  logger: new PinoLogger({
    name: 'Fulfillment A2A',
    level: 'info',
  }),
});
