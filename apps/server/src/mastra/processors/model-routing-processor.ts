import { Agent } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/agent';
import type {
  Processor,
  ProcessInputStepArgs,
  ProcessInputStepResult,
} from '@mastra/core/processors';
import { z } from 'zod';

/**
 * Model routing demo: a tiny, cheap classifier LLM inspects the latest user
 * message and picks which model should answer it.
 *
 * Design choices (each one addresses a known criticism of model routing):
 *
 * - The classifier is asked to label the *kind* of request (small fixed label
 *   set), not to judge "is this hard?" in the abstract. Tiny models are
 *   reliable at intent classification, unreliable at difficulty estimation
 *   ("the router paradox").
 * - Routing happens ONCE at step 0 and the decision is pinned in `state` for
 *   the rest of the agentic loop, so tool-call continuations don't flip
 *   models mid-run.
 * - Any classifier failure fails OPEN to the strong model. Routing an easy
 *   query to the strong model wastes cents; routing a hard query to the weak
 *   model is a silent quality failure.
 * - The decision is made visible: streamed to the client as a
 *   `data-model-routing` chunk and logged, so users are never silently
 *   downgraded (the GPT-5 router lesson).
 */

const ROUTE_LABELS = ['chat', 'lookup', 'writing', 'reasoning', 'code'] as const;
type RouteLabel = (typeof ROUTE_LABELS)[number];

const classificationSchema = z.object({
  label: z
    .enum(ROUTE_LABELS)
    .describe('The category that best matches the user request'),
  reason: z.string().describe('One short sentence explaining the choice'),
});

export interface ModelRoutingOptions {
  /** Cheap/fast model for simple requests */
  cheapModel: string;
  /** Strong model for complex requests */
  strongModel: string;
  /** Tiny model that performs the classification */
  routerModel: string;
  /** Labels that route to the strong model (default: reasoning, code) */
  strongLabels?: RouteLabel[];
  /** Max characters of user text sent to the classifier (default: 2000) */
  maxClassifierChars?: number;
}

export interface RoutingDecision {
  label: RouteLabel | 'unknown';
  model: string;
  tier: 'cheap' | 'strong';
  reason: string;
  classifierMs: number;
}

export class ModelRoutingProcessor implements Processor {
  readonly id = 'model-routing';

  private readonly cheapModel: string;
  private readonly strongModel: string;
  private readonly strongLabels: Set<RouteLabel>;
  private readonly maxClassifierChars: number;
  private readonly routerAgent: Agent;

  constructor(options: ModelRoutingOptions) {
    this.cheapModel = options.cheapModel;
    this.strongModel = options.strongModel;
    this.strongLabels = new Set(options.strongLabels ?? ['reasoning', 'code']);
    this.maxClassifierChars = options.maxClassifierChars ?? 2000;
    this.routerAgent = new Agent({
      id: 'model-router-classifier',
      name: 'Model Router Classifier',
      model: options.routerModel,
      instructions: `You classify user requests into exactly one category:
- chat: greetings, small talk, thanks, simple opinions
- lookup: asking for a fact, definition, or short explanation
- writing: drafting or editing prose (emails, docs, summaries)
- reasoning: multi-step analysis, math, planning, comparing trade-offs
- code: writing, reviewing, or debugging code

Pick the single best label. Respond only with the structured output.`,
    });
  }

  async processInputStep(
    args: ProcessInputStepArgs,
  ): Promise<ProcessInputStepResult> {
    const { stepNumber, state, messages, writer, abortSignal } = args;

    // Route once at step 0, then pin the decision for tool-call continuations.
    if (stepNumber > 0) {
      const pinned = state.routingDecision as RoutingDecision | undefined;
      return pinned ? { model: pinned.model } : {};
    }

    const userText = this.latestUserText(messages);
    const decision = await this.classify(userText, abortSignal);
    state.routingDecision = decision;

    // Make the routing decision visible instead of silently swapping models.
    console.info(
      `[ModelRoutingProcessor] label=${decision.label} tier=${decision.tier} model=${decision.model} (${decision.classifierMs}ms): ${decision.reason}`,
    );
    await writer?.custom({ type: 'data-model-routing', data: decision });

    return { model: decision.model };
  }

  private async classify(
    userText: string,
    abortSignal?: AbortSignal,
  ): Promise<RoutingDecision> {
    const started = Date.now();

    if (!userText.trim()) {
      return {
        label: 'unknown',
        model: this.strongModel,
        tier: 'strong',
        reason: 'No user text found; failing open to the strong model',
        classifierMs: 0,
      };
    }

    try {
      const response = await this.routerAgent.generate(
        `Classify this user request:\n\n${userText.slice(0, this.maxClassifierChars)}`,
        {
          structuredOutput: { schema: classificationSchema },
          modelSettings: { temperature: 0 },
          abortSignal,
        },
      );
      if (!response.object) {
        throw new Error('classifier returned no structured output');
      }
      const { label, reason } = response.object;
      const strong = this.strongLabels.has(label);
      return {
        label,
        model: strong ? this.strongModel : this.cheapModel,
        tier: strong ? 'strong' : 'cheap',
        reason,
        classifierMs: Date.now() - started,
      };
    } catch (error) {
      // Fail open: a broken router must never silently degrade answers.
      return {
        label: 'unknown',
        model: this.strongModel,
        tier: 'strong',
        reason: `Classifier failed (${error instanceof Error ? error.message : 'unknown error'}); failing open to the strong model`,
        classifierMs: Date.now() - started,
      };
    }
  }

  private latestUserText(messages: MastraDBMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== 'user') continue;
      let text = '';
      for (const part of message.content.parts ?? []) {
        if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
          text += part.text + ' ';
        }
      }
      if (text.trim()) return text.trim();
    }
    return '';
  }
}
