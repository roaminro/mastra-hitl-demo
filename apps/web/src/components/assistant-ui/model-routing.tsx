"use client";

import { memo, useState } from "react";
import { ChevronDownIcon, RouteIcon, ShieldAlertIcon, ZapIcon } from "lucide-react";
import { makeAssistantDataUI } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * The routing-agent's ModelRoutingProcessor streams its decision as a single
 * `data-model-routing` part at step 0 (see
 * apps/server/src/mastra/processors/model-routing-processor.ts). Rendering it
 * makes the routing visible — the user always sees which model answered and
 * why, never a silent downgrade.
 */

type RoutingDecisionData = {
  label?: string;
  model?: string;
  tier?: "cheap" | "strong";
  reason?: string;
  classifierMs?: number;
};

/** "openrouter/openai/gpt-5.4-mini" -> "gpt-5.4-mini" */
const shortModel = (model?: string) => model?.split("/").pop() ?? "unknown";

const RoutingDecision = memo(function RoutingDecision({
  data,
}: {
  data: RoutingDecisionData;
}) {
  const [open, setOpen] = useState(false);
  const strong = data.tier === "strong";
  const failedOpen = data.label === "unknown";

  return (
    <div
      className={
        "my-1.5 rounded-lg border text-xs " +
        (strong
          ? "border-amber-400/40 bg-amber-500/5"
          : "border-emerald-400/40 bg-emerald-500/5")
      }
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <span className={strong ? "text-amber-500" : "text-emerald-500"}>
            {failedOpen ? (
              <ShieldAlertIcon className="size-3.5" />
            ) : strong ? (
              <RouteIcon className="size-3.5" />
            ) : (
              <ZapIcon className="size-3.5" />
            )}
          </span>
          <span className="flex-1 font-medium">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              Routed to{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono">
                {shortModel(data.model)}
              </code>
              <span
                className={
                  "rounded-full px-1.5 py-px font-semibold uppercase tracking-wide " +
                  (strong
                    ? "bg-amber-500/15 text-amber-600"
                    : "bg-emerald-500/15 text-emerald-600")
                }
              >
                {data.tier ?? "?"}
              </span>
              <span className="text-muted-foreground font-normal">
                {failedOpen ? "fail-open" : data.label}
                {typeof data.classifierMs === "number"
                  ? ` · ${data.classifierMs}ms`
                  : ""}
              </span>
            </span>
          </span>
          <ChevronDownIcon
            className={
              "size-3.5 text-muted-foreground transition-transform " +
              (open ? "rotate-180" : "")
            }
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border/60 text-muted-foreground border-t px-3 py-2">
            {data.reason ?? "No reason provided."}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});

/** Mount inside the runtime provider to register the routing renderer. */
export const ModelRoutingUI = makeAssistantDataUI<RoutingDecisionData>({
  name: "model-routing",
  render: RoutingDecision,
});
