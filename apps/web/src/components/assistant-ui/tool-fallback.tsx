"use client";

import { memo, useCallback, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import {
  useScrollLock,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  SubagentCard,
  restoredOutputToSubagentData,
  type SubagentData,
} from "@/components/assistant-ui/subagent-activity";

const ANIMATION_DURATION = 200;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        className,
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

function ToolFallbackTrigger({
  toolName,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];
  const label = isCancelled ? "Cancelled tool" : "Used tool";

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit items-center gap-2 py-1 text-sm transition-colors",
        className,
      )}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          isCancelled && "text-muted-foreground",
          isRunning && "animate-spin",
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper relative inline-block text-start leading-none",
          isCancelled && "text-muted-foreground line-through",
        )}
      >
        <span>
          {label}: <b>{toolName}</b>
        </span>
        {isRunning && (
          <span
            aria-hidden
            data-slot="tool-fallback-trigger-shimmer"
            className="aui-tool-fallback-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}: <b>{toolName}</b>
          </span>
        )}
      </span>
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-2 ps-6 pt-1 pb-2">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args", className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value bg-muted/50 text-muted-foreground rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {argsText}
      </pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  result?: unknown;
}) {
  if (result === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result", className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-muted-foreground text-xs font-medium">
        Result:
      </p>
      <pre className="aui-tool-fallback-result-content bg-muted/50 text-muted-foreground mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isCancelled = status.reason === "cancelled";
  const headerText = isCancelled ? "Cancelled reason:" : "Error:";

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">
        {errorText}
      </p>
    </div>
  );
}

const APPROVED_RESULT = "Approved by user";
const DENIED_RESULT = "User denied tool execution";

function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  ...props
}: React.ComponentProps<"div"> &
  Partial<
    Pick<ToolCallMessagePartProps, "addResult" | "resume" | "respondToApproval">
  > & {
    interrupt?: ToolCallMessagePart["interrupt"];
    approval?: ToolCallMessagePart["approval"];
  }) {
  const [submitted, setSubmitted] = useState(false);

  const respond = (approved: boolean) => {
    if (submitted) return;
    setSubmitted(true);
    // Prefer the native approval channel. `respondToApproval` is scoped to
    // this part's runtime context, so it resolves the correct pending
    // approval even when the `approval` object didn't make it onto the
    // rendered props (happens for the 2nd+ of several parallel approvals on
    // the same tool). Only fall back to `resume`/`addResult` when there is no
    // native approval responder at all.
    if (respondToApproval && (approval == null || approval.approved === undefined)) {
      respondToApproval({ approved });
    } else if (interrupt) {
      resume?.({ approved });
    } else {
      addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
    }
  };

  return (
    <div
      data-slot="tool-fallback-approval"
      className={cn(
        "aui-tool-fallback-approval flex items-center gap-2 pt-1",
        className,
      )}
      {...props}
    >
      <Button size="sm" onClick={() => respond(true)} disabled={submitted}>
        Allow
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => respond(false)}
        disabled={submitted}
      >
        Deny
      </Button>
    </div>
  );
}

const humanizeAgentToolName = (toolName: string) =>
  toolName
    .replace(/^agent-/, "")
    .replace(/[Aa]gent$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || toolName;

/**
 * Approval-only view for a subagent delegation (`agent-*` tool) that is
 * waiting on an Allow/Deny decision. The live work for the delegation is
 * rendered separately by the `SubagentActivity` data-part renderer, so this
 * intentionally renders just the decision prompt rather than a second card.
 */
/**
 * Best-effort human-readable description of what a delegation is asking to do.
 * The `agent-*` tool input carries a `prompt` field with the rep's instruction
 * (e.g. "Issue a refund for order ord_2002 in the amount of 60 USD…"), which is
 * exactly what an approver needs to see. Falls back to the raw args text.
 */
function describeDelegation(args: unknown, argsText?: string): string | undefined {
  if (args && typeof args === "object") {
    const prompt = (args as Record<string, unknown>).prompt;
    if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
  }
  if (argsText && argsText.trim() && argsText.trim() !== "{}") return argsText.trim();
  return undefined;
}

function AgentApprovalPrompt({
  toolName,
  args,
  argsText,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  hideDescription = false,
}: Pick<
  ToolCallMessagePartProps,
  "addResult" | "resume" | "respondToApproval"
> & {
  toolName: string;
  args?: unknown;
  argsText?: string;
  interrupt?: ToolCallMessagePart["interrupt"];
  approval?: ToolCallMessagePart["approval"];
  /** Suppress the request description (e.g. when an enclosing card shows it). */
  hideDescription?: boolean;
}) {
  const description = hideDescription
    ? undefined
    : describeDelegation(args, argsText);
  return (
    <div
      data-slot="agent-approval-prompt"
      className="border-border/60 bg-muted/20 my-1 flex flex-col gap-1.5 rounded-lg border px-3 py-2.5"
    >
      <div className="text-foreground flex items-center gap-2 text-sm">
        <AlertCircleIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <span>
          <b>{humanizeAgentToolName(toolName)}</b> needs approval to continue
        </span>
      </div>
      {description && (
        <p
          data-slot="agent-approval-description"
          className="text-muted-foreground border-border/50 ms-6 border-s ps-2.5 text-xs leading-relaxed"
        >
          {description}
        </p>
      )}
      <ToolFallbackApproval
        addResult={addResult}
        resume={resume}
        interrupt={interrupt}
        approval={approval}
        respondToApproval={respondToApproval}
      />
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = (props) => {
  // Subagent delegations (`agent-*` tools) are special-cased so we never show
  // the same delegation twice. Handled in a wrapper so neither path runs hooks
  // conditionally.
  if (props.toolName.startsWith("agent-")) {
    return <AgentDelegationToolPart {...props} />;
  }
  return <StandardToolFallback {...props} />;
};

/**
 * Compact summary card for a subagent delegation (`agent-*` tool). Used for
 * delegations that are *not* live-streaming: completed ones restored from
 * history after a page refresh (when the live `SubagentActivity` data-part is
 * gone) and any finished delegation. While a delegation is actively running,
 * the richer `SubagentActivity` data-part owns the display and this renders
 * nothing to avoid a duplicate card. Approval requests render the Allow/Deny
 * prompt (the approval UI must live on this tool-call part, not the data part).
 */
const AgentDelegationToolPart: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  // A delegation awaits a decision whenever the runtime marks it
  // `requires-action`. With several approvals pending in parallel, the AI SDK
  // only attaches the `approval` object to one of the same-named tool parts —
  // the others still report `requires-action` but arrive with `approval` and
  // `interrupt` undefined. We must still render an Allow/Deny for those, or a
  // second pending approval silently falls through to the "completed" card.
  // `respondToApproval` is bound to *this* part's runtime context, so it
  // resolves the right approval even when the prop is missing.
  const isRequiresAction =
    status?.type === "requires-action" && result === undefined;

  if (isRequiresAction) {
    // While streaming live, the `SubagentActivity` data-part already renders
    // the rich "Delegating to X" card with the subagent's in-flight work, so
    // here we only need the bare Allow/Deny prompt (avoids a duplicate card).
    //
    // But after a page refresh the live data-part is gone and the suspended
    // delegation comes back from history as this `requires-action` tool-call
    // with no result — previously that left just a floating approval prompt
    // with no context (see MASTRA_DX_FEEDBACK.md: in-flight delegation progress
    // isn't persisted at suspend time). Detect the restored case by the
    // placeholder approval id assigned in `mastra-threads.tsx` and wrap the
    // prompt in the SAME `SubagentCard` shell — a "Delegating to X" card whose
    // body shows the request description and hosts the buttons.
    const isRestoredApproval =
      typeof approval?.id === "string" && approval.id.startsWith("pending-run::");

    if (!isRestoredApproval) {
      return (
        <AgentApprovalPrompt
          toolName={toolName}
          args={args}
          argsText={argsText}
          addResult={addResult}
          resume={resume}
          interrupt={interrupt}
          approval={approval}
          respondToApproval={respondToApproval}
        />
      );
    }

    const data: SubagentData = {
      id: toolName.replace(/^agent-/, ""),
      text: "",
      status: "running",
      toolCalls: [],
      toolResults: [],
    };
    return (
      <SubagentCard
        data={data}
        prompt={describeDelegation(args, argsText)}
        footer={
          // The card already shows the request as its prompt, so hide the
          // prompt's own copy to avoid showing the description twice.
          <AgentApprovalPrompt
            toolName={toolName}
            args={args}
            argsText={argsText}
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
            hideDescription
          />
        }
      />
    );
  }

  // Running live: the SubagentActivity data-part renders the rich card.
  if (status?.type === "running") return null;

  // Finished / restored from history: the live `data-tool-agent` part no longer
  // exists, so reshape the persisted delegation output into the same
  // `SubagentData` the live renderer uses and render the SAME recursive
  // `SubagentCard`. This keeps recalled history visually identical to live —
  // including nested (multi-level) delegations and the subagent's tool rows.
  // Without this, a delegation would disappear entirely after a page refresh.
  return <AgentDelegationSummary toolName={toolName} result={result} />;
};

function AgentDelegationSummary({
  toolName,
  result,
}: {
  toolName: string;
  result?: unknown;
}) {
  const data = restoredOutputToSubagentData(toolName, result);
  if (!data) return null;
  return <SubagentCard data={data} />;
}

const StandardToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  // Only offer Allow/Deny when this part actually carries an approval
  // request or interrupt. Tool calls restored from history without their
  // result would otherwise also report `requires-action` and render
  // buttons that fake a local result instead of resuming the run.
  const isRequiresAction =
    status?.type === "requires-action" &&
    ((approval != null && approval.approved === undefined) ||
      interrupt != null);

  const [open, setOpen] = useState(isRequiresAction);
  const [prevRequiresAction, setPrevRequiresAction] =
    useState(isRequiresAction);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) setOpen(true);
  }

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs
          argsText={argsText}
          className={cn(isCancelled && "opacity-60")}
        />
        {isRequiresAction && (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
          />
        )}
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
