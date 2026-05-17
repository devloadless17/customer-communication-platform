"use client";

/**
 * Tiny typing-dots indicator. Filters out the viewer so they don't see
 * their own typing reflected back. Renders nothing when nobody else is
 * typing — collapses cleanly into the layout.
 */
export function TypingIndicator({
  userIds,
  namesById,
  viewerUserId,
}: {
  userIds: string[];
  namesById: Map<string, string>;
  viewerUserId?: string;
}) {
  const others = viewerUserId ? userIds.filter((id) => id !== viewerUserId) : userIds;
  if (others.length === 0) return null;

  const names = others
    .map((id) => namesById.get(id) ?? "Someone")
    .slice(0, 3);
  let label: string;
  if (others.length === 1) label = `${names[0]} is typing…`;
  else if (others.length === 2) label = `${names[0]} and ${names[1]} are typing…`;
  else label = `${names[0]}, ${names[1]} and ${others.length - 2} more are typing…`;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-0.5">
        <span className="size-1 animate-pulse rounded-full bg-current" style={{ animationDelay: "0ms" }} />
        <span className="size-1 animate-pulse rounded-full bg-current" style={{ animationDelay: "200ms" }} />
        <span className="size-1 animate-pulse rounded-full bg-current" style={{ animationDelay: "400ms" }} />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}
