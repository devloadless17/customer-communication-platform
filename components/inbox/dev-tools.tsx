"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wrench, X, Inbox as InboxIcon, CheckCheck, StickyNote, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConversationWithRefs, User } from "@/lib/types";

/**
 * Floating dev panel — only renders in development. Fires fake events into
 * the dev emitter API so we can poke the realtime layer without Evolution
 * being paired.
 *
 * NEVER ship this to production: the panel is gated by NODE_ENV at build
 * time AND the API route returns 404 in production.
 */
export function DevTools({
  conversations,
  currentUser,
}: {
  conversations: ConversationWithRefs[];
  currentUser: User;
}) {
  if (process.env.NODE_ENV === "production") return null;

  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const target =
    conversations.find((c) => c.conversation.id === selectedId) ??
    conversations[0] ??
    null;

  async function fire(body: object, key: string) {
    setPendingId(key);
    try {
      const res = await fetch("/api/dev/emit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.warn("[dev-tools] request failed", res.status);
    } catch (err) {
      console.warn("[dev-tools]", err);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-4 right-4 z-50 flex size-10 items-center justify-center rounded-full",
          "bg-foreground text-background shadow-lg ring-1 ring-border",
          "transition-transform hover:scale-105",
        )}
        aria-label="Toggle dev tools"
      >
        {open ? <X className="size-4" /> : <Wrench className="size-4" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="fixed bottom-16 right-4 z-50 w-[340px] overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
          >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Wrench className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Dev tools
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">socket.io</span>
            </header>

            <div className="px-3 py-3">
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Target conversation
              </label>
              <select
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                value={target?.conversation.id ?? ""}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {conversations.map(({ conversation, contact }) => (
                  <option key={conversation.id} value={conversation.id}>
                    {contact.name} · {conversation.id.slice(0, 12)}
                  </option>
                ))}
              </select>
            </div>

            {target && (
              <div className="grid grid-cols-1 gap-1.5 px-3 pb-3">
                <ActionButton
                  pending={pendingId === "msg"}
                  onClick={() =>
                    fire(
                      {
                        kind: "fake-inbound-message",
                        conversationId: target.conversation.id,
                        body: pickRandom([
                          "Quick follow-up — any update?",
                          "Wanted to check in on this.",
                          "👋 hello?",
                          "Thanks for getting back to me!",
                          "Actually, one more question…",
                        ]),
                      },
                      "msg",
                    )
                  }
                  icon={<InboxIcon className="size-3.5" />}
                  label="Fake inbound message"
                  desc={`As ${target.contact.name}`}
                />
                <ActionButton
                  pending={pendingId === "read"}
                  onClick={() =>
                    fire(
                      { kind: "mark-last-read", conversationId: target.conversation.id },
                      "read",
                    )
                  }
                  icon={<CheckCheck className="size-3.5" />}
                  label="Bump last outbound status"
                  desc="sent → delivered → read"
                />
                <ActionButton
                  pending={pendingId === "note"}
                  onClick={() =>
                    fire(
                      {
                        kind: "add-fake-note",
                        conversationId: target.conversation.id,
                        authorUserId: currentUser.id,
                        body: "Note from dev tools — pretend a teammate added this.",
                      },
                      "note",
                    )
                  }
                  icon={<StickyNote className="size-3.5" />}
                  label="Add fake internal note"
                  desc={`Authored by ${currentUser.name}`}
                />
              </div>
            )}

            <footer className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
              Dev only — route 404s in production.
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ActionButton({
  icon,
  label,
  desc,
  onClick,
  pending,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
  pending: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={pending}
      className="h-auto justify-start gap-2 py-2 text-left"
    >
      <span className="mt-0.5 text-muted-foreground">{pending ? <Loader2 className="size-3.5 animate-spin" /> : icon}</span>
      <span className="flex-1">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[10px] font-normal text-muted-foreground">{desc}</span>
      </span>
    </Button>
  );
}

function pickRandom<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)] as T;
}
