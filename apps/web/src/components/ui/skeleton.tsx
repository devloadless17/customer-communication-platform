import { cn } from "@ccp/shared/utils";

/**
 * The one loading-placeholder primitive. Before this existed the app had five
 * hand-rolled skeletons and fifteen raw `animate-pulse` sites, each picking
 * its own rounding and muted tone — the audit's loading-state survey read as
 * five different products. Every placeholder block goes through here so the
 * pulse, tone and radius stay one decision.
 *
 * Geometry stays at the call site (width/height/rounded-full via className) —
 * a skeleton is only calm when it mirrors the real content's layout, and only
 * the caller knows that layout. See `team/[channelId]/loading.tsx` for the
 * house style: quiet, low-contrast, anchored where the real content lands.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
