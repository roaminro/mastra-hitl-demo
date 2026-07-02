import { Agent } from '@mastra/core/agent';
import { ModelRoutingProcessor } from '../processors/model-routing-processor';

// Demonstrates dynamic model routing with a custom processor.
//
// The agent's static `model` is only a fallback — on every request the
// ModelRoutingProcessor runs a tiny classifier (gpt-5.4-nano, ~$0.20/M input,
// ~$0.00002 per routing call) over the latest user message and overrides the
// model for the whole run via `processInputStep()`:
//
//   chat / lookup / writing  -> cheap tier  (gpt-5.4-mini)
//   reasoning / code         -> strong tier (gpt-5.4)
//   classifier error / empty -> strong tier (fail open)
//
// The decision is streamed to the client as a `data-model-routing` chunk and
// logged server-side, so the routing is always visible — never a silent
// downgrade. Try it in Studio with contrasting prompts, e.g.:
//   "hey, how's it going?"                        -> cheap
//   "what's the capital of Australia?"            -> cheap
//   "write a function that balances a red-black
//    tree and explain the invariants"             -> strong
export const routingAgent = new Agent({
  id: 'routing-agent',
  name: 'Model Routing Demo',
  description:
    'Demo agent for dynamic model routing. A nano-class classifier labels each request (chat/lookup/writing/reasoning/code) and routes it to a cheap or strong model via processInputStep(), failing open to the strong model.',
  instructions: `You are a helpful general-purpose assistant.

Answer the user's question directly and well. Keep simple answers short;
give thorough, structured answers for complex reasoning or coding requests.

A routing layer picks which model runs you for each request. If the user asks
which model handled their request or why, tell them the routing decision is
shown alongside the response and explain that simple requests go to a fast,
cheap model while reasoning and coding requests go to a stronger one.`,
  // Fallback only — the ModelRoutingProcessor overrides this at step 0.
  model: 'openrouter/openai/gpt-5.4',
  inputProcessors: [
    new ModelRoutingProcessor({
      routerModel: 'openrouter/openai/gpt-5.4-nano',
      cheapModel: 'openrouter/openai/gpt-5.4-mini',
      strongModel: 'openrouter/openai/gpt-5.4',
    }),
  ],
});
