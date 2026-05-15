/**
 * Conversation page skeleton — fires on a click between threads while the
 * server fetches the new conversation's messages, notes, and references.
 * The inbox layout (sidebar + conversation list) stays rendered because
 * its segment didn't change; only the right two panes swap.
 *
 * Bubble widths alternate left/right + jittered so the silhouette reads as
 * "a real conversation loading," not a generic grid of grey boxes.
 */
const BUBBLES: Array<{ side: "in" | "out"; width: number }> = [
  { side: "in", width: 220 },
  { side: "in", width: 140 },
  { side: "out", width: 180 },
  { side: "out", width: 280 },
  { side: "in", width: 260 },
  { side: "out", width: 160 },
  { side: "in", width: 200 },
];

export default function ConversationLoading() {
  return (
    <>
      {/* Message thread pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="size-9 animate-pulse rounded-full bg-muted/50" />
          <div className="flex flex-col gap-1.5">
            <div className="h-3.5 w-32 animate-pulse rounded bg-muted/60" />
            <div className="h-2.5 w-24 animate-pulse rounded bg-muted/30" />
          </div>
          <div className="ml-auto h-7 w-20 animate-pulse rounded-md bg-muted/30" />
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-hidden px-6 py-5">
          {BUBBLES.map((b, i) => (
            <div
              key={i}
              className={
                b.side === "out"
                  ? "ml-auto flex max-w-[70%] flex-col items-end gap-1.5"
                  : "mr-auto flex max-w-[70%] flex-col items-start gap-1.5"
              }
            >
              <div
                className={
                  b.side === "out"
                    ? "h-9 animate-pulse rounded-2xl rounded-br-md bg-primary/20"
                    : "h-9 animate-pulse rounded-2xl rounded-bl-md bg-muted/50"
                }
                style={{ width: b.width }}
              />
              <div className="h-2 w-10 animate-pulse rounded bg-muted/30" />
            </div>
          ))}
        </div>

        <div className="border-t border-border px-4 py-3">
          <div className="h-10 w-full animate-pulse rounded-md bg-muted/30" />
        </div>
      </div>

      {/* Contact panel */}
      <aside className="flex w-80 shrink-0 flex-col gap-4 border-l border-border bg-card px-5 py-5">
        <div className="flex flex-col items-center gap-2">
          <div className="size-16 animate-pulse rounded-full bg-muted/50" />
          <div className="h-3.5 w-32 animate-pulse rounded bg-muted/60" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-muted/30" />
        </div>
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="h-2 w-16 animate-pulse rounded bg-muted/30" />
              <div
                className="h-3 animate-pulse rounded bg-muted/40"
                style={{ width: 120 + ((i * 19) % 80) }}
              />
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
