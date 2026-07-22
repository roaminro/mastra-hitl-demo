"use client";

import { useState, type FC } from "react";
import { ImageIcon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";

/**
 * Composer button that attaches an image *by URL* — no upload. The URL is
 * stored as an image attachment; on send, assistant-ui's AI SDK runtime
 * converts it into a `{ type: "file", url, mediaType }` part, so the model
 * provider fetches the image itself. On thread reload, the same runtime maps
 * persisted user file parts back into image attachments, so the existing
 * attachment thumbnails/preview render it with zero extra code.
 */
export const ComposerAddImageUrl: FC = () => {
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setError("Enter a valid URL.");
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setError("Only http(s) URLs are supported.");
      return;
    }

    const name = parsed.pathname.split("/").filter(Boolean).pop() ?? "image";
    aui.composer().addAttachment({
      type: "image",
      name,
      contentType: guessMediaType(parsed.pathname),
      content: [{ type: "image", image: trimmed }],
    });
    setUrl("");
    setError(null);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipIconButton
        tooltip="Attach image by URL"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon"
        className="aui-composer-add-image-url hover:bg-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1"
        aria-label="Attach image by URL"
        onClick={() => setOpen(true)}
      >
        <ImageIcon className="size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="text-sm font-semibold">
          Attach image by URL
        </DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-2"
        >
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            placeholder="https://example.com/photo.jpg"
            autoFocus
            className="border-border bg-background focus-visible:ring-ring rounded-md border px-2.5 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
            aria-label="Image URL"
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!url.trim()}>
              Attach
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const guessMediaType = (pathname: string): string => {
  const ext = pathname.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
};
