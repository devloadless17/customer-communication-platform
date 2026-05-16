"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Renders time-derived text only after hydration. SSR and the first client
 * paint emit `fallback` (empty by default); a layout effect swaps in the
 * formatted string before the browser paints the next frame, so the user
 * never sees the server's UTC value flash before the local one.
 *
 * Pass a module-level `format` reference — an inline arrow re-creates each
 * parent render, which re-fires the effect (the write is a no-op but it's
 * wasted work).
 */
export function LocalTime({
  iso,
  format,
  fallback = "",
  className,
}: {
  iso: string | Date | null | undefined;
  format: (iso: string) => string;
  fallback?: ReactNode;
  className?: string;
}) {
  const [text, setText] = useState<ReactNode>(fallback);
  useEffect(() => {
    if (iso == null) {
      setText(fallback);
      return;
    }
    const s = iso instanceof Date ? iso.toISOString() : iso;
    setText(format(s));
  }, [iso, format, fallback]);
  return <span className={className}>{text}</span>;
}
