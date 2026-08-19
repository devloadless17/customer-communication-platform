"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@ccp/shared/utils";

/**
 * Pick WHICH PART of an image is shown — the profile-photo interaction everyone
 * already knows from LinkedIn.
 *
 * Why this exists: the widget renders a logo/avatar into a fixed square box with
 * `object-fit: cover`, so a wide image gets centre-cropped whether that suits it
 * or not — a wordmark loses its ends, a group photo keeps the wrong face, and the
 * uploader had no say. Storing a SQUARE the user framed themselves makes `cover`
 * a no-op, so what they see here is exactly what their customers get.
 *
 * The mask mirrors where the image actually lands (circle for a message avatar,
 * rounded square for the header logo). The exported PNG/WebP is always the full
 * square — the rounding is applied at render time, so a mask change downstream
 * can't crop someone's logo a second time.
 */

/** Editing stage, in CSS px. Big enough to frame accurately on a laptop. */
const STAGE = 264;
const MAX_ZOOM = 5;

export function ImageCropDialog({
  file,
  shape,
  outPx,
  maxBytes,
  title,
  onCancel,
  onApply,
}: {
  file: File;
  /** Mirrors how the image is masked where it renders. */
  shape: "circle" | "rounded";
  /** Edge of the exported square, in px. */
  outPx: number;
  /** Cap for the encoded data URL — the config rides to every visitor. */
  maxBytes: number;
  title: string;
  onCancel: () => void;
  onApply: (dataUrl: string) => void;
}) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [minScale, setMinScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Decode once; keep an object URL for the live preview so panning never
  // re-encodes anything.
  useEffect(() => {
    let cancelled = false;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    createImageBitmap(file)
      .then((bm) => {
        if (cancelled) {
          bm.close?.();
          return;
        }
        // Start at "just covers the stage", centred — the same framing the
        // widget would have chosen, so Apply-without-touching is a no-op.
        const fit = STAGE / Math.min(bm.width, bm.height);
        setBitmap(bm);
        setMinScale(fit);
        setScale(fit);
        setPos({ x: (STAGE - bm.width * fit) / 2, y: (STAGE - bm.height * fit) / 2 });
      })
      .catch(() => setErr("Couldn't read that image"));
    return () => {
      cancelled = true;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => () => bitmap?.close?.(), [bitmap]);

  /** Keep the image covering the stage — no empty corners, ever. */
  const clamp = useCallback(
    (p: { x: number; y: number }, s: number) => {
      if (!bitmap) return p;
      const minX = STAGE - bitmap.width * s;
      const minY = STAGE - bitmap.height * s;
      return {
        x: Math.min(0, Math.max(minX, p.x)),
        y: Math.min(0, Math.max(minY, p.y)),
      };
    },
    [bitmap],
  );

  /** Zoom about the stage centre, so the framing doesn't lurch. */
  const zoomTo = useCallback(
    (next: number) => {
      if (!bitmap) return;
      const s = Math.min(minScale * MAX_ZOOM, Math.max(minScale, next));
      setPos((p) => {
        const cx = (STAGE / 2 - p.x) / scale;
        const cy = (STAGE / 2 - p.y) / scale;
        return clamp({ x: STAGE / 2 - cx * s, y: STAGE / 2 - cy * s }, s);
      });
      setScale(s);
    },
    [bitmap, clamp, minScale, scale],
  );

  async function apply() {
    if (!bitmap) return;
    setBusy(true);
    setErr(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = outPx;
      canvas.height = outPx;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // The visible stage square, mapped back into source pixels.
      const sSize = STAGE / scale;
      ctx.drawImage(bitmap, -pos.x / scale, -pos.y / scale, sSize, sSize, 0, 0, outPx, outPx);
      const webp = canvas.toDataURL("image/webp", 0.85);
      const out = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
      if (out.length > maxBytes) {
        setErr("Couldn't compress that image enough — try a simpler one");
        return;
      }
      onApply(out);
    } catch {
      setErr("Couldn't process that image");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onCancel}>
      <DialogContent className="max-w-sm" ariaLabel={title}>
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Drag to reposition, zoom to frame. Only what you see here is shown to customers.
            </p>
          </div>

          <div
            className="relative mx-auto touch-none overflow-hidden rounded-xl bg-muted"
            style={{ width: STAGE, height: STAGE }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setPos(clamp({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }, scale));
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onWheel={(e) => {
              // Trackpad/wheel zoom, the same gesture the interaction implies.
              zoomTo(scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
            }}
          >
            {url && bitmap && (
              <div
                className="size-full cursor-grab active:cursor-grabbing"
                style={{
                  backgroundImage: `url(${url})`,
                  backgroundRepeat: "no-repeat",
                  backgroundSize: `${bitmap.width * scale}px ${bitmap.height * scale}px`,
                  backgroundPosition: `${pos.x}px ${pos.y}px`,
                }}
              />
            )}
            {/* Everything outside the shape dims, so the framing decision is the
                shape the customer will actually see — not a square guess. */}
            <div
              className={cn(
                "pointer-events-none absolute inset-0 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]",
                shape === "circle" ? "rounded-full" : "rounded-[18%]",
              )}
            />
          </div>

          <div className="flex items-center gap-3">
            <ZoomOut className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="range"
              aria-label="Zoom"
              min={minScale}
              max={minScale * MAX_ZOOM}
              step={minScale / 100}
              value={scale}
              onChange={(e) => zoomTo(Number(e.target.value))}
              className="h-1 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            />
            <ZoomIn className="size-4 shrink-0 text-muted-foreground" />
          </div>

          {err && <p className="text-2xs text-destructive">{err}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void apply()} disabled={!bitmap || busy}>
              {busy ? "Saving…" : "Use this"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
