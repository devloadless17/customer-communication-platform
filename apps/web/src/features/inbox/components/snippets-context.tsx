"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { SnippetItem } from "@ccp/shared/types";

/**
 * Team-wide snippet catalog, hydrated server-side by `app/inbox/layout.tsx`.
 *
 * Snippets are a per-team list that's identical for every conversation —
 * agents use them in any chat. Fetching them inside `ReplyBox` was tying
 * team-wide state to a chat-scoped component's lifecycle, which caused a
 * fresh HTTP request on every chat switch (doubled by StrictMode in dev).
 * The right scope is the inbox layout: it owns the team session, hydrates
 * the catalog once, and any number of ReplyBox instances read it through
 * this context for free.
 */
const SnippetsContext = createContext<SnippetItem[] | null>(null);

export function SnippetsProvider({
  snippets,
  children,
}: {
  snippets: SnippetItem[];
  children: ReactNode;
}) {
  return (
    <SnippetsContext.Provider value={snippets}>
      {children}
    </SnippetsContext.Provider>
  );
}

/**
 * Read the team's snippets. Returns an empty array (not null) when used
 * outside the provider — that way callers can render the slash menu shell
 * unconditionally and just show "no snippets" if there genuinely are none.
 */
export function useSnippets(): SnippetItem[] {
  return useContext(SnippetsContext) ?? [];
}
