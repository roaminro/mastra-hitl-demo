"use client";

import { memo, useState } from "react";
import {
  BrainIcon,
  ChevronDownIcon,
  LoaderIcon,
  SparklesIcon,
} from "lucide-react";
import { makeAssistantDataUI } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * Observational Memory (OM) streams its lifecycle as `data-om-*` parts on the
 * agent stream (see @mastra/memory markers.ts). We render them so the user can
 * SEE the Observer firing — context filling up, compaction running, and raw
 * messages being evicted from the window.
 *
 * Shapes below mirror the marker payloads:
 *  - data-om-status            : per-step fuel gauge (active.messages.tokens vs threshold)
 *  - data-om-observation-start : Observer began compacting `tokensToObserve`
 *  - data-om-observation-end   : compaction done; `tokensObserved` -> `observationTokens`
 *  - data-om-observation-failed: compaction errored
 *  - data-om-activation        : buffered observations swapped in; raw messages evicted
 */

type OmStatusData = {
  windows?: {
    active?: {
      messages?: { tokens?: number; threshold?: number };
      observations?: { tokens?: number; threshold?: number };
    };
    buffered?: {
      observations?: { chunks?: number; status?: string };
    };
  };
  threadId?: string;
  stepNumber?: number;
};

type OmObservationStartData = {
  cycleId?: string;
  operationType?: string;
  tokensToObserve?: number;
};

type OmObservationEndData = {
  cycleId?: string;
  operationType?: string;
  durationMs?: number;
  tokensObserved?: number;
  observationTokens?: number;
  currentTask?: string;
  suggestedResponse?: string;
};

type OmObservationFailedData = {
  cycleId?: string;
  durationMs?: number;
  error?: string;
};

type OmActivationData = {
  cycleId?: string;
  chunksActivated?: number;
  tokensActivated?: number;
  messagesActivated?: number;
  observationTokens?: number;
  triggeredBy?: string;
};

const fmtTokens = (n?: number): string => {
  if (typeof n !== "number") return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const Shell = ({
  icon,
  title,
  tone = "muted",
  children,
  defaultOpen = false,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  tone?: "muted" | "active";
  children?: React.ReactNode;
  defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const hasBody = Boolean(children);
  return (
    <div
      className={
        "my-1.5 rounded-lg border text-xs " +
        (tone === "active"
          ? "border-violet-400/40 bg-violet-500/5"
          : "border-border bg-muted/30")
      }
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          disabled={!hasBody}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <span className="text-violet-500">{icon}</span>
          <span className="flex-1 font-medium">{title}</span>
          {hasBody && (
            <ChevronDownIcon
              className={
                "size-3.5 text-muted-foreground transition-transform " +
                (open ? "rotate-180" : "")
              }
            />
          )}
        </CollapsibleTrigger>
        {hasBody && (
          <CollapsibleContent>
            <div className="border-border/60 text-muted-foreground border-t px-3 py-2">
              {children}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
};

/** A thin progress bar showing message tokens vs the observation threshold. */
const Gauge = ({ tokens, threshold }: { tokens?: number; threshold?: number }) => {
  if (typeof tokens !== "number" || typeof threshold !== "number" || threshold <= 0)
    return null;
  const pct = Math.min(100, Math.round((tokens / threshold) * 100));
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="bg-border h-1.5 flex-1 overflow-hidden rounded-full">
        <div
          className={
            "h-full rounded-full " +
            (pct >= 100 ? "bg-violet-500" : "bg-violet-400/70")
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-muted-foreground tabular-nums">
        {fmtTokens(tokens)}/{fmtTokens(threshold)}
      </span>
    </div>
  );
};

const OmStatus = memo(function OmStatus({ data }: { data: OmStatusData }) {
  const messages = data.windows?.active?.messages;
  const observations = data.windows?.active?.observations;
  const buffered = data.windows?.buffered?.observations;
  const buffering = buffered?.status === "running";

  return (
    <Shell
      icon={
        buffering ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <BrainIcon className="size-3.5" />
        )
      }
      title={
        <span className="flex items-center gap-2">
          Memory
          <span className="text-muted-foreground font-normal">
            {buffering
              ? "buffering observations…"
              : `${fmtTokens(messages?.tokens)} ctx tokens`}
          </span>
        </span>
      }
    >
      <div className="space-y-2">
        <div>
          <div className="text-foreground/80 mb-0.5 font-medium">
            Context window
          </div>
          <Gauge tokens={messages?.tokens} threshold={messages?.threshold} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            Observations: {fmtTokens(observations?.tokens)}/
            {fmtTokens(observations?.threshold)}
          </span>
          {typeof buffered?.chunks === "number" && (
            <span>Buffered chunks: {buffered.chunks}</span>
          )}
        </div>
      </div>
    </Shell>
  );
});

const OmObservationStart = memo(function OmObservationStart({
  data,
}: {
  data: OmObservationStartData;
}) {
  return (
    <Shell
      tone="active"
      icon={<LoaderIcon className="size-3.5 animate-spin" />}
      title={
        <span className="flex items-center gap-2">
          Compacting memory
          <span className="text-muted-foreground font-normal">
            observing {fmtTokens(data.tokensToObserve)} tokens…
          </span>
        </span>
      }
    />
  );
});

const OmObservationEnd = memo(function OmObservationEnd({
  data,
}: {
  data: OmObservationEndData;
}) {
  return (
    <Shell
      tone="active"
      icon={<SparklesIcon className="size-3.5" />}
      title={
        <span className="flex items-center gap-2">
          Memory compacted
          <span className="text-muted-foreground font-normal">
            {fmtTokens(data.tokensObserved)} → {fmtTokens(data.observationTokens)} tokens
            {typeof data.durationMs === "number"
              ? ` · ${(data.durationMs / 1000).toFixed(1)}s`
              : ""}
          </span>
        </span>
      }
    >
      {(data.currentTask || data.suggestedResponse) && (
        <div className="space-y-1.5">
          {data.currentTask && (
            <div>
              <span className="text-foreground/80 font-medium">Current task: </span>
              {data.currentTask}
            </div>
          )}
          {data.suggestedResponse && (
            <div>
              <span className="text-foreground/80 font-medium">
                Continuity hint:{" "}
              </span>
              {data.suggestedResponse}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
});

const OmObservationFailed = memo(function OmObservationFailed({
  data,
}: {
  data: OmObservationFailedData;
}) {
  return (
    <Shell
      icon={<BrainIcon className="size-3.5" />}
      title={
        <span className="flex items-center gap-2 text-destructive">
          Memory compaction failed
        </span>
      }
    >
      <div className="text-destructive">{data.error ?? "Unknown error"}</div>
    </Shell>
  );
});

const OmActivation = memo(function OmActivation({
  data,
}: {
  data: OmActivationData;
}) {
  return (
    <Shell
      tone="active"
      icon={<SparklesIcon className="size-3.5" />}
      title={
        <span className="flex items-center gap-2">
          Memory activated
          <span className="text-muted-foreground font-normal">
            {typeof data.messagesActivated === "number"
              ? `${data.messagesActivated} messages compressed`
              : "context compressed"}
          </span>
        </span>
      }
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {typeof data.chunksActivated === "number" && (
          <span>Chunks activated: {data.chunksActivated}</span>
        )}
        {typeof data.tokensActivated === "number" && (
          <span>Tokens activated: {fmtTokens(data.tokensActivated)}</span>
        )}
        {data.triggeredBy && <span>Trigger: {data.triggeredBy}</span>}
      </div>
      <div className="text-foreground/70 mt-1.5 italic">
        Raw messages were evicted from the context window. Exact details remain
        recallable (retrieval mode).
      </div>
    </Shell>
  );
});

/**
 * Mount inside the runtime provider to register all OM data renderers. Renders
 * nothing itself; `thread.tsx` routes `case "data": return part.dataRendererUI`.
 */
export const OmStatusUI = makeAssistantDataUI<OmStatusData>({
  name: "om-status",
  render: OmStatus,
});
export const OmObservationStartUI = makeAssistantDataUI<OmObservationStartData>({
  name: "om-observation-start",
  render: OmObservationStart,
});
export const OmObservationEndUI = makeAssistantDataUI<OmObservationEndData>({
  name: "om-observation-end",
  render: OmObservationEnd,
});
export const OmObservationFailedUI = makeAssistantDataUI<OmObservationFailedData>({
  name: "om-observation-failed",
  render: OmObservationFailed,
});
export const OmActivationUI = makeAssistantDataUI<OmActivationData>({
  name: "om-activation",
  render: OmActivation,
});

/**
 * Registers the OM lifecycle renderers.
 *
 * Mastra emits OM lifecycle as *separate, id-less* data parts, so assistant-ui
 * cannot reconcile a later part onto an earlier one. That rules out any
 * "in-progress → done" swap:
 *
 *   - `data-om-status` fires every step → would stack one card per step.
 *   - `data-om-observation-start` has no matching end to replace it → its
 *     spinner would hang forever even though the paired `observation-end`
 *     (same `cycleId`) already arrived.
 *
 * So we only render the *terminal* events, which fire rarely (only when the
 * threshold is actually crossed) and each represent a completed fact:
 *   - `observation-end`    → "Memory compacted" (with the token reduction)
 *   - `observation-failed` → error
 *   - `activation`         → "Memory activated" (raw messages evicted)
 *
 * `OmStatusUI` / `OmObservationStartUI` are exported for an out-of-thread,
 * transient indicator (e.g. a header gauge) if desired, but are not mounted
 * inline here.
 */
export const OmActivityUI = () => (
  <>
    <OmObservationEndUI />
    <OmObservationFailedUI />
    <OmActivationUI />
  </>
);
