"use client";

import { type PropsWithChildren, useEffect, useState, type FC } from "react";
import { XIcon, PlusIcon, FileText } from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

const useFileSrc = (file: File | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) return;

    const objectUrl = URL.createObjectURL(file);
    // Async so the effect body doesn't set state synchronously.
    queueMicrotask(() => setSrc(objectUrl));

    return () => {
      URL.revokeObjectURL(objectUrl);
      setSrc((current) => (current === objectUrl ? undefined : current));
    };
  }, [file]);

  return file ? src : undefined;
};

const useAttachmentSrc = () => {
  const { file, src, contentType } = useAuiState(
    useShallow((s): { file?: File; src?: string; contentType?: string } => {
      const attachment = s.attachment;
      if (attachment.type === "image") {
        if (attachment.file)
          return { file: attachment.file, contentType: "image" };
        const src = attachment.content?.filter((c) => c.type === "image")[0]
          ?.image;
        if (!src) return {};
        return { src, contentType: "image" };
      }
      // Documents/files: URL-based attachments carry a `file` part whose
      // `data` is the URL (or a data URL for uploaded files).
      const filePart = attachment.content?.filter((c) => c.type === "file")[0];
      if (filePart && typeof filePart.data === "string") {
        return {
          src: filePart.data,
          contentType: filePart.mimeType || attachment.contentType,
        };
      }
      if (attachment.file) {
        return { file: attachment.file, contentType: attachment.contentType };
      }
      return {};
    }),
  );

  const fileSrc = useFileSrc(file);
  return { src: fileSrc ?? src, contentType };
};

type AttachmentPreviewProps = {
  src: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full object-contain",
        isLoaded
          ? "aui-attachment-preview-image-loaded"
          : "aui-attachment-preview-image-loading invisible",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

/**
 * Renders a PDF in an iframe. Hosts often serve PDFs with the wrong
 * content-type (e.g. raw.githubusercontent sends application/octet-stream +
 * nosniff), which browsers refuse to render inline — so we fetch the bytes
 * and re-wrap them in a correctly-typed blob URL. Falls back to the direct
 * URL if the fetch fails (e.g. CORS-restricted hosts).
 */
const PdfPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [blobSrc, setBlobSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;

    fetch(src)
      .then((res) => (res.ok ? res.blob() : Promise.reject(res.status)))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(
          new Blob([blob], { type: "application/pdf" }),
        );
        setBlobSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setBlobSrc(src);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setBlobSrc(undefined);
    };
  }, [src]);

  return (
    <div className="flex h-[80dvh] w-full flex-col gap-1.5">
      {blobSrc ? (
        <iframe
          src={blobSrc}
          title="PDF attachment preview"
          className="min-h-0 w-full flex-1 rounded-md border"
        />
      ) : (
        <div className="text-muted-foreground flex min-h-0 w-full flex-1 items-center justify-center rounded-md border text-sm">
          Loading PDF…
        </div>
      )}
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground self-end text-xs underline"
      >
        Open in new tab
      </a>
    </div>
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const { src, contentType } = useAttachmentSrc();

  if (!src) return children;

  const isPdf = contentType === "application/pdf";

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger hover:bg-accent/50 cursor-pointer transition-colors"
      >
        {children}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">
          Attachment Preview
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden">
          {isPdf ? <PdfPreview src={src} /> : <AttachmentPreview src={src} />}
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const { src, contentType } = useAttachmentSrc();
  // Only images can render as a thumbnail; documents fall through to the icon.
  const imageSrc = contentType?.startsWith("image") ? src : undefined;

  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage
        src={imageSrc}
        alt="Attachment preview"
        className="aui-attachment-tile-image object-cover"
      />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground size-8" />
      </AvatarFallback>
    </Avatar>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return type;
    }
  });

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        className={cn(
          "aui-attachment-root relative",
          isImage &&
            !isComposer &&
            "aui-attachment-root-message only:*:first:size-24",
        )}
      >
        <AttachmentPreviewDialog>
          <TooltipTrigger render={<div className="aui-attachment-tile bg-muted size-14 cursor-pointer overflow-hidden rounded-md border transition-opacity hover:opacity-75" role="button" tabIndex={0} aria-label={`${typeLabel} attachment`} />}><AttachmentThumb /></TooltipTrigger>
        </AttachmentPreviewDialog>
        {isComposer && <AttachmentRemove />}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top">
        <AttachmentPrimitive.Name />
      </TooltipContent>
    </Tooltip>
  );
};

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove render={<TooltipIconButton tooltip="Remove file" className="aui-attachment-tile-remove text-muted-foreground hover:[&_svg]:text-destructive absolute end-1.5 top-1.5 size-3.5 rounded-full bg-white opacity-100 shadow-sm hover:bg-white! [&_svg]:text-black" side="top" />}><XIcon className="aui-attachment-remove-icon size-3 dark:stroke-[2.5px]" /></AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment render={<TooltipIconButton tooltip="Add Attachment" side="bottom" variant="ghost" size="icon" className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold" aria-label="Add Attachment" />}><PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" /></ComposerPrimitive.AddAttachment>
  );
};
