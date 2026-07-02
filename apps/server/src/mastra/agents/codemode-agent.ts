import { Agent } from '@mastra/core/agent';
import { createCodeMode } from '@mastra/core/tools';
import { LocalSandbox } from '@mastra/core/workspace';
import {
  getAccountTransactionsTool,
  listAccountsTool,
  listTransactionsTool,
} from '../tools/analytics-tools';

// Demonstrates Mastra code mode (beta, @mastra/core >= 1.38).
//
// The analytics tools return raw lists only — 500 transactions, 40 accounts,
// no server-side aggregation. Without code mode the agent would have to pull
// those lists into its context window and do arithmetic by token prediction.
// With code mode, the model writes ONE TypeScript function per query that
// calls the tools as `external_*` functions inside a sandbox, joins/filters/
// reduces the lists there, and returns a single small structured result.
//
// The tools themselves still execute on the host (with schema validation and
// tracing) — only the model-authored orchestration code runs in the sandbox.
// LocalSandbox executes on this machine and is fine for a local demo; use a
// remote/isolated sandbox in production.
const { tool: codeModeTool, instructions: codeModeInstructions } = createCodeMode({
  tools: {
    listTransactions: listTransactionsTool,
    listAccounts: listAccountsTool,
    getAccountTransactions: getAccountTransactionsTool,
  },
  sandbox: new LocalSandbox(),
  timeout: 30_000,
});

export const codemodeAgent = new Agent({
  id: 'codemode-agent',
  name: 'Code Mode Demo',
  description:
    'Demo agent for Mastra code mode: analytics tools return large raw lists, and the agent writes sandboxed TypeScript to join, filter, and aggregate them into one small result.',
  instructions: [
    `You are a billing analytics assistant for 2026 data.

The analytics tools return LARGE raw lists with no aggregation. Never try to
read or summarize those lists yourself — always use the code execution tool to
fetch, join, filter, and aggregate the data in code, returning only the final
compact result. Do all arithmetic in code, never in your head.

Amounts are in cents; convert to dollars (divide by 100) in your final answer.
Present results concisely, using tables for grouped numbers.`,
    codeModeInstructions,
  ],
  model: 'openrouter/openai/gpt-5.4',
  tools: { execute_typescript: codeModeTool },
});
