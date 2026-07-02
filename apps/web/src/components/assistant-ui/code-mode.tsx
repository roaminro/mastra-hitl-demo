"use client";

import { useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  Code2Icon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";

/**
 * ToolFallback override that gives the codemode-agent's `execute_typescript`
 * calls a dedicated renderer (see
 * apps/server/src/mastra/agents/codemode-agent.ts) and delegates every other
 * tool to the stock `ToolFallback`. The whole point of the code mode demo is
 * the model-authored orchestration code, so it renders the generated
 * TypeScript as a code block plus the sandbox's aggregated result and logs —
 * instead of an escaped JSON string.
 *
 * Pass to the thread via `<Thread components={{ ToolFallback: ... }} />`.
 */

type CodeModeArgs = {
  code?: string;
};

type CodeModeResult = {
  success?: boolean;
  result?: unknown;
  logs?: string[];
  error?: { message: string; name?: string; line?: number };
};

const CodeModeCall: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
}) => {
  const [open, setOpen] = useState(false);
  const { code } = args as CodeModeArgs;
  const outcome = result as CodeModeResult | undefined;
  const running = status.type === "running";
  const failed = outcome?.success === false || status.type === "incomplete";

  return (
    <div
      className={
        "my-1.5 rounded-lg border text-xs " +
        (failed
          ? "border-red-400/40 bg-red-500/5"
          : "border-sky-400/40 bg-sky-500/5")
      }
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <span className={failed ? "text-red-500" : "text-sky-500"}>
            {running ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : failed ? (
              <XCircleIcon className="size-3.5" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
          </span>
          <Code2Icon className="text-muted-foreground size-3.5" />
          <span className="flex-1 font-medium">
            {running
              ? "Running sandboxed TypeScript…"
              : failed
                ? "Sandboxed TypeScript failed"
                : "Ran sandboxed TypeScript"}
            {code ? (
              <span className="text-muted-foreground font-normal">
                {" "}
                · {code.split("\n").length} lines
              </span>
            ) : null}
          </span>
          <ChevronDownIcon
            className={
              "text-muted-foreground size-3.5 transition-transform " +
              (open ? "rotate-180" : "")
            }
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border/60 flex flex-col gap-2 border-t px-3 py-2">
            {code ? (
              <div>
                <p className="text-muted-foreground pb-1 font-medium">
                  Generated code
                </p>
                <pre className="bg-muted/50 max-h-72 overflow-auto rounded-md p-2.5 font-mono whitespace-pre">
                  {code}
                </pre>
              </div>
            ) : null}
            {outcome?.error ? (
              <div>
                <p className="pb-1 font-medium text-red-500">Error</p>
                <pre className="rounded-md bg-red-500/10 p-2.5 font-mono whitespace-pre-wrap">
                  {outcome.error.message}
                </pre>
              </div>
            ) : null}
            {outcome?.result !== undefined ? (
              <div>
                <p className="text-muted-foreground pb-1 font-medium">
                  Aggregated result
                </p>
                <pre className="bg-muted/50 max-h-48 overflow-auto rounded-md p-2.5 font-mono whitespace-pre-wrap">
                  {JSON.stringify(outcome.result, null, 2)}
                </pre>
              </div>
            ) : null}
            {outcome?.logs?.length ? (
              <div>
                <p className="text-muted-foreground pb-1 font-medium">Logs</p>
                <pre className="bg-muted/50 max-h-32 overflow-auto rounded-md p-2.5 font-mono whitespace-pre-wrap">
                  {outcome.logs.join("\n")}
                </pre>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

export const CodeModeToolFallback: ToolCallMessagePartComponent = (part) => {
  if (part.toolName === "execute_typescript") return <CodeModeCall {...part} />;
  return <ToolFallback {...part} />;
};
