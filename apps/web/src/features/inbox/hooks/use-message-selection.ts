"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Multi-select state for the message thread. `start(id)` flips the thread into
 * selection mode (optionally pre-checking the message the user acted on);
 * `clear()` exits. Deliberately tiny — the thread owns rendering, this just
 * holds the set.
 */
export interface MessageSelection {
  selecting: boolean;
  selectedIds: Set<string>;
  count: number;
  start: (initialId?: string) => void;
  toggle: (id: string) => void;
  isSelected: (id: string) => boolean;
  clear: () => void;
}

export function useMessageSelection(): MessageSelection {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const start = useCallback((initialId?: string) => {
    setSelecting(true);
    setSelectedIds(initialId ? new Set([initialId]) : new Set());
  }, []);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  const clear = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
  }, []);

  return useMemo(
    () => ({
      selecting,
      selectedIds,
      count: selectedIds.size,
      start,
      toggle,
      isSelected,
      clear,
    }),
    [selecting, selectedIds, start, toggle, isSelected, clear],
  );
}
