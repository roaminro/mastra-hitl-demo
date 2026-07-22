"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import { BrainIcon, CheckIcon, CopyIcon, LoaderIcon } from "lucide-react";
import { useAuiState } from "@assistant-ui/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AGENT_ID,
  MASTRA_URL,
  RESOURCE_ID,
  resolveMastraThreadId,
} from "@/lib/mastra-threads";

/**
 * Composer-level Observational Memory indicator.
 *
 * The inline thread cards (om-activity.tsx) only render *terminal* OM events
 * (compaction / activation), which fire rarely. This strip surfaces the
 * continuous state instead: it reads the latest `data-om-status` part in the
 * thread (persisted, so it survives reload) and shows a small context gauge
 * next to the composer buttons. While the background Observer is buffering
 * (`data-om-buffering-start` without a matching end), the brain icon pulses.
 *
 * Clicking the strip opens a dialog that fetches the actual OM record from
 * Mastra's built-in `GET /api/memory/observational-memory` endpoint and shows
 * the observation content: active observations, buffered chunks, current task,
 * and continuity hints.
 */

type OmStatusData = {
  threadId?: string;
  windows?: {
    active?: {
      messages?: { tokens?: number; threshold?: number };
      observations?: { tokens?: number; threshold?: number };
    };
    buffered?: {
      observations?: { chunks?: number; status?: string };
    };
  };
};

type OmBufferingData = { cycleId?: string; threadId?: string };

type OmRecord = {
  id: string;
  scope?: string;
  generationCount?: number;
  activeObservations?: string;
  observationTokenCount?: number;
  pendingMessageTokens?: number;
  isReflecting?: boolean;
  isBufferingReflection?: boolean;
  config?: { reflection?: { observationTokens?: number } };
  updatedAt?: string;
  bufferedObservationChunks?: Array<{
    id: string;
    observations?: string;
    tokenCount?: number;
    messageTokens?: number;
    currentTask?: string;
    suggestedContinuation?: string;
  }>;
};

const fmtTokens = (n?: number): string => {
  if (typeof n !== "number") return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

/** Drop the `<observation-group …>` XML wrapper for readability. */
const cleanObservations = (text?: string): string =>
  (text ?? "")
    .replace(/<\/?observation-group[^>]*>/g, "")
    .trim();

type DataPartLike = { type: string; name?: string; data?: unknown };

/** Latest OM state derived from the thread's `data-om-*` message parts. */
const useOmThreadState = () => {
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  return useMemo(() => {
    // Delegated subagents run with their own OM record on a derived thread id
    // (`<parentThreadId>-<uuid>`), and their `data-om-*` events are forwarded
    // into the same UI stream. Only track the parent thread's record here,
    // otherwise the gauge flips to the subagent's (much smaller) counter
    // mid-turn and back again.
    const dataParts = messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.content as readonly DataPartLike[]).filter(
            (part) => part.type === "data",
          )
        : [],
    );
    // Step 0 emits the parent status before any delegation, so the first OM
    // status is a safe fallback while a new local thread has no remote ID yet.
    const firstStatus = dataParts.find((part) => part.name === "om-status")
      ?.data as OmStatusData | undefined;
    const parentThreadId = remoteId
      ? resolveMastraThreadId(remoteId)
      : firstStatus?.threadId;
    const isParentPart = (data: { threadId?: string } | undefined): boolean =>
      !data?.threadId || !parentThreadId || data.threadId === parentThreadId;

    let status: OmStatusData | undefined;
    let lastStart: OmBufferingData | undefined;
    let lastEnd: OmBufferingData | undefined;
    for (const part of dataParts) {
      if (part.name === "om-status") {
        const data = part.data as OmStatusData;
        if (isParentPart(data)) status = data;
      } else if (part.name === "om-buffering-start") {
        const data = part.data as OmBufferingData;
        if (isParentPart(data)) lastStart = data;
      } else if (part.name === "om-buffering-end") {
        const data = part.data as OmBufferingData;
        if (isParentPart(data)) lastEnd = data;
      }
    }
    // The background Observer can finish after the response stream closes, in
    // which case `om-buffering-end` never lands in a persisted message. Only
    // trust the start/end pairing while the thread is actively streaming;
    // once idle, nothing is visibly in flight.
    const buffering =
      isRunning &&
      ((lastStart && lastStart.cycleId !== lastEnd?.cycleId) ||
        status?.windows?.buffered?.observations?.status === "running");
    return { status, buffering: Boolean(buffering) };
  }, [messages, isRunning, remoteId]);
};

const CopyableId: FC<{ label: string; value: string }> = ({ label, value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 font-mono"
    >
      {value}
      {copied ? (
        <CheckIcon className="size-3 text-emerald-500" />
      ) : (
        <CopyIcon className="size-3" />
      )}
    </button>
  );
};

const OmContentDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const threadId = remoteId ? resolveMastraThreadId(remoteId) : undefined;
  const [result, setResult] = useState<{
    threadId: string;
    record: OmRecord | null;
    error: boolean;
  }>();

  useEffect(() => {
    if (!open || !threadId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      agentId: AGENT_ID,
      threadId,
      resourceId: RESOURCE_ID,
    });
    fetch(`${MASTRA_URL}/api/memory/observational-memory?${params}`, {
      signal: controller.signal,
    })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error(String(response.status))),
      )
      .then((json: { record?: OmRecord | null }) =>
        setResult({ threadId, record: json.record ?? null, error: false }),
      )
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setResult({ threadId, record: null, error: true });
        }
      });
    return () => controller.abort();
  }, [open, threadId]);

  const currentResult = result?.threadId === threadId ? result : undefined;
  const state = currentResult
    ? currentResult.error
      ? "error"
      : "idle"
    : "loading";
  const record = currentResult?.record ?? null;
  const active = cleanObservations(record?.activeObservations);
  const chunks = record?.bufferedObservationChunks ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
          <BrainIcon className="size-4 text-violet-500" />
          Observational memory
        </DialogTitle>
        <div className="text-muted-foreground -mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {threadId && <CopyableId label="thread id" value={threadId} />}
          {record?.id && state === "idle" && (
            <span>
              record: <CopyableId label="record id" value={record.id} />
            </span>
          )}
        </div>
        {state === "loading" && (
          <div className="text-muted-foreground flex items-center gap-2 py-4 text-xs">
            <LoaderIcon className="size-3.5 animate-spin" /> Loading memory
            record…
          </div>
        )}
        {state === "error" && (
          <div className="text-destructive py-4 text-xs">
            Could not load the memory record.
          </div>
        )}
        {state === "idle" && !record && (
          <div className="text-muted-foreground py-4 text-xs">
            No observational memory exists for this thread yet.
          </div>
        )}
        {state === "idle" && record && (
          <div className="space-y-4 text-xs">
            <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>Scope: {record.scope ?? "thread"}</span>
              <span>
                Active observations: {fmtTokens(record.observationTokenCount)}{" "}
                tokens
              </span>
              <span>
                Unobserved messages: {fmtTokens(record.pendingMessageTokens)}{" "}
                tokens
              </span>
            </div>

            <section>
              <h3 className="text-foreground/80 mb-1 font-semibold">
                Reflection
                <span className="text-muted-foreground ml-1.5 font-normal">
                  (condenses observations once they outgrow their own budget)
                </span>
              </h3>
              <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  Generation: {record.generationCount ?? 0}
                  {(record.generationCount ?? 0) === 0 && " (never reflected)"}
                </span>
                <span>
                  Observations at {fmtTokens(record.observationTokenCount)}/
                  {fmtTokens(record.config?.reflection?.observationTokens)}{" "}
                  reflection threshold
                </span>
                {record.isReflecting && (
                  <span className="text-violet-600">reflecting now…</span>
                )}
                {record.isBufferingReflection && (
                  <span className="text-violet-600">
                    buffering reflection in background…
                  </span>
                )}
              </div>
            </section>

            <section>
              <h3 className="text-foreground/80 mb-1 font-semibold">
                Active observations
                <span className="text-muted-foreground ml-1.5 font-normal">
                  (currently replacing raw history in the context window)
                </span>
              </h3>
              {active ? (
                <pre className="bg-muted/40 border-border max-h-64 overflow-y-auto rounded-md border p-2.5 font-sans whitespace-pre-wrap">
                  {active}
                </pre>
              ) : (
                <p className="text-muted-foreground">
                  None yet — no compaction or activation has happened, so the
                  agent still sees the raw messages.
                </p>
              )}
            </section>

            <section>
              <h3 className="text-foreground/80 mb-1 font-semibold">
                Buffered chunks
                <span className="text-muted-foreground ml-1.5 font-normal">
                  (pre-compacted in the background, not yet activated)
                </span>
              </h3>
              {chunks.length === 0 ? (
                <p className="text-muted-foreground">No buffered chunks.</p>
              ) : (
                <div className="space-y-2">
                  {chunks.map((chunk) => (
                    <div
                      key={chunk.id}
                      className="border-border rounded-md border"
                    >
                      <div className="text-muted-foreground border-border/60 flex flex-wrap gap-x-3 border-b px-2.5 py-1.5">
                        <span>
                          {fmtTokens(chunk.messageTokens)} msg tokens →{" "}
                          {fmtTokens(chunk.tokenCount)} obs tokens
                        </span>
                      </div>
                      <pre className="bg-muted/40 max-h-48 overflow-y-auto p-2.5 font-sans whitespace-pre-wrap">
                        {cleanObservations(chunk.observations)}
                      </pre>
                      {(chunk.currentTask || chunk.suggestedContinuation) && (
                        <div className="border-border/60 text-muted-foreground space-y-1 border-t px-2.5 py-1.5">
                          {chunk.currentTask && (
                            <div>
                              <span className="text-foreground/80 font-medium">
                                Current task:{" "}
                              </span>
                              {chunk.currentTask}
                            </div>
                          )}
                          {chunk.suggestedContinuation && (
                            <div>
                              <span className="text-foreground/80 font-medium">
                                Continuity hint:{" "}
                              </span>
                              {chunk.suggestedContinuation}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export const ComposerOmStatus: FC = () => {
  const { status, buffering } = useOmThreadState();
  const [open, setOpen] = useState(false);

  if (!status) return null;

  const messages = status.windows?.active?.messages;
  const observations = status.windows?.active?.observations;
  const bufferedChunks = status.windows?.buffered?.observations?.chunks ?? 0;
  const pct =
    typeof messages?.tokens === "number" &&
    typeof messages?.threshold === "number" &&
    messages.threshold > 0
      ? Math.min(100, Math.round((messages.tokens / messages.threshold) * 100))
      : 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          buffering
            ? "Observer is buffering in the background — click to view memory"
            : pct >= 100
              ? "Context is over the observation threshold — memory will compact on the next turn. Click to view."
              : "Observational memory — click to view"
        }
        className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px]"
      >
        {buffering ? (
          <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
        ) : (
          <BrainIcon
            className={
              "size-3.5 " + (pct >= 100 ? "text-amber-500" : "text-violet-500")
            }
          />
        )}
        <span className="bg-border h-1 w-16 overflow-hidden rounded-full">
          <span
            className={
              "block h-full rounded-full " +
              (pct >= 100 ? "bg-amber-500" : "bg-violet-400/70")
            }
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
        <span className="tabular-nums">
          {fmtTokens(messages?.tokens)}/{fmtTokens(messages?.threshold)}
        </span>
        {pct >= 100 && <span className="text-amber-600">· compacts next turn</span>}
        {typeof observations?.tokens === "number" && observations.tokens > 0 && (
          <span>· {fmtTokens(observations.tokens)} obs</span>
        )}
        {bufferedChunks > 0 && <span>· {bufferedChunks} buffered</span>}
      </button>
      <OmContentDialog open={open} onOpenChange={setOpen} />
    </>
  );
};
