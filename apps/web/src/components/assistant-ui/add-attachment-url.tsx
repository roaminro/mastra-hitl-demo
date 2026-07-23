"use client";

import { useState, type FC } from "react";
import { LinkIcon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";

/**
 * Composer button that attaches a file *by URL* — no upload. The URL is stored
 * as an attachment; on send, assistant-ui's AI SDK runtime converts it into a
 * `{ type: "file", url, mediaType }` part, so the model provider fetches the
 * content itself. Works for any media type the runtime can carry, but what the
 * model actually accepts depends on the provider — images and PDFs are the
 * reliable cases; other types may be rejected at request time.
 */
export const ComposerAddAttachmentUrl: FC = () => {
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

    const name = parsed.pathname.split("/").filter(Boolean).pop() ?? "file";
    const mediaType = guessMediaType(parsed.pathname);
    if (!mediaType) {
      setError(
        "Unsupported file type — use an image, PDF, or audio URL.",
      );
      return;
    }
    const isImage = mediaType.startsWith("image/");

    aui.composer().addAttachment(
      isImage
        ? {
            type: "image",
            name,
            contentType: mediaType,
            content: [{ type: "image", image: trimmed }],
          }
        : {
            type: mediaType === "application/pdf" ? "document" : "file",
            name,
            contentType: mediaType,
            content: [
              {
                type: "file",
                mimeType: mediaType,
                filename: name,
                data: trimmed,
              },
            ],
          },
    );
    setUrl("");
    setError(null);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipIconButton
        tooltip="Attach file by URL"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment-url hover:bg-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1"
        aria-label="Attach file by URL"
        onClick={() => setOpen(true)}
      >
        <LinkIcon className="size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="text-sm font-semibold">
          Attach file by URL
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
            placeholder="https://example.com/photo.jpg or …/report.pdf"
            autoFocus
            className="border-border bg-background focus-visible:ring-ring rounded-md border px-2.5 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
            aria-label="File URL"
          />
          <p className="text-muted-foreground text-xs">
            Images and PDFs work with most models; audio requires an
            audio-capable model.
          </p>
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

/**
 * Only types at least one mainstream provider accepts as a `file` part:
 * images (vision models), PDF (Claude/Gemini/OpenAI via OpenRouter), and
 * audio (audio-capable models only). Text/CSV/JSON and arbitrary binaries
 * are rejected by providers, so we fail fast in the dialog instead.
 * Returns undefined for unsupported extensions.
 */
const guessMediaType = (pathname: string): string | undefined => {
  const ext = pathname.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    default:
      return undefined;
  }
};
