"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Download, Loader2, Plus, QrCode, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@ccp/shared/utils";

/**
 * QR codes and short links — a scannable doorstep into a chat.
 *
 * A customer scans the code (or taps the link) and lands in a conversation with
 * the business, with a message already typed. No phone number to key in, and
 * the prefilled text is editable afterwards — which is the advantage over a
 * hand-rolled `wa.me` link with the message baked into the URL.
 *
 * Two things Meta fixes that shape this UI: a number holds at most 2,000 codes,
 * and there are **no analytics at all** (a deliberate privacy choice). So there
 * is no scan count to show and nothing to poll — this is pure CRUD.
 */

interface QrCode {
  code: string;
  prefilledMessage: string;
  deepLinkUrl: string;
  qrImageUrl?: string;
}

/** Meta's cap, and the reason the feature works: it lands in the chat box. */
const PREFILL_MAX = 140;

export function QrCodesPanel({
  canManage,
  accountId,
}: {
  canManage: boolean;
  accountId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [codes, setCodes] = useState<QrCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/whatsapp/qr-codes${query}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      setCodes(((await res.json()) as { codes: QrCode[] }).codes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load QR codes");
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Lazy: a Graph read per number, and most people never open this.
  useEffect(() => {
    if (open && codes === null && !loading) void load();
  }, [open, codes, loading, load]);

  async function create() {
    if (!draft.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/whatsapp/qr-codes${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // SVG: these end up on packaging and signage, where a raster image at
        // print size is the thing people regret.
        body: JSON.stringify({ prefilledMessage: draft.trim(), imageFormat: "SVG" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      const { code } = (await res.json()) as { code: QrCode };
      setCodes((cur) => [code, ...(cur ?? [])]);
      setDraft("");
      toast.success("QR code created — download the image before you leave");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the QR code");
    } finally {
      setCreating(false);
    }
  }

  async function remove(target: QrCode) {
    const ok = await confirm({
      title: "Delete this QR code?",
      // The consequence is physical: someone may have printed it.
      description:
        `Anything already printed or published with this code stops working — ` +
        `customers who scan it will see “This QR code has expired.”\n\n` +
        `To change the message instead, edit it: the link keeps working.`,
      confirmLabel: "Delete QR code",
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await apiFetch(
        `/api/workspace/whatsapp/qr-codes/${encodeURIComponent(target.code)}${query}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCodes((cur) => (cur ?? []).filter((c) => c.code !== target.code));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the QR code");
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <QrCode className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">QR codes &amp; short links</div>
          <div className="text-2xs text-muted-foreground">
            Let customers start a chat by scanning or tapping
          </div>
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          {error && (
            <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {canManage && (
            <div className="mb-4 flex flex-col gap-1.5">
              <label className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                New code — the message the customer arrives with
              </label>
              <div className="flex gap-2">
                <Input
                  value={draft}
                  maxLength={PREFILL_MAX}
                  placeholder="Hi! I saw your poster and I'd like to know more."
                  onChange={(e) => setDraft(e.target.value)}
                  className="text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void create()}
                  disabled={creating || draft.trim().length === 0}
                >
                  {creating ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Plus className="size-3.5" />
                  )}
                  Create
                </Button>
              </div>
              <p
                className={cn(
                  "text-2xs text-muted-foreground",
                  draft.length > PREFILL_MAX && "text-destructive",
                )}
              >
                {draft.length}/{PREFILL_MAX} — this text lands in their chat box,
                ready to send.
              </p>
            </div>
          )}

          {(codes ?? []).some((c) => c.qrImageUrl) && (
            <p className="mb-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-2xs leading-relaxed text-warning-fg">
              <strong>Save the image now.</strong> WhatsApp only hands over the
              QR image when a code is created — reopen this page and the download
              is gone. Getting it back would mean deleting the code and making a
              new one, which stops any version already printed from working.
            </p>
          )}

          {codes && codes.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No QR codes yet. Create one for a poster, a receipt, or product
              packaging — customers scan it and land straight in a chat with you.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {(codes ?? []).map((c) => (
              <div
                key={c.code}
                className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-foreground">
                    {c.prefilledMessage || (
                      <span className="text-muted-foreground">No prefilled message</span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
                    {c.deepLinkUrl}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 text-2xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(c.deepLinkUrl);
                    toast.success("Link copied");
                  }}
                >
                  <Copy className="size-3" />
                  Copy
                </Button>
                {/* WhatsApp returns the image URL ONLY from the create call —
                    the list never carries it. So this link exists for exactly
                    as long as this page stays open, and the only other way to
                    obtain the image is to delete the code and make a new one,
                    which breaks whatever was printed with the old one. Hence
                    the emphasis rather than a quiet secondary link. */}
                {c.qrImageUrl && (
                  <a
                    href={c.qrImageUrl}
                    target="_blank"
                    rel="noreferrer"
                    download
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 text-2xs font-medium text-primary hover:bg-primary/15"
                  >
                    <Download className="size-3" />
                    Save image
                  </a>
                )}
                {canManage && (
                  <button
                    type="button"
                    onClick={() => void remove(c)}
                    className="mt-0.5 text-muted-foreground hover:text-destructive"
                    aria-label="Delete QR code"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {codes && codes.length > 0 && (
            <p className="mt-3 text-2xs text-muted-foreground">
              WhatsApp doesn&apos;t report scan counts for QR codes — it
              deliberately logs as little as possible about them.
            </p>
          )}
        </div>
      )}
      {confirmDialog}
    </section>
  );
}
