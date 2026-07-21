"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import type { MessageFlagDefinition } from "@ccp/shared/types";
import type { MessageFlagStatus } from "@ccp/shared/message-flags/types";

import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

/**
 * The team's message-flag catalog + the mutations that act on it, hydrated
 * server-side by the inbox page and shared by every bubble.
 *
 * Scoped exactly like `SnippetsProvider`: the catalog is team-wide and
 * identical for every conversation, so fetching it inside the bubble would
 * mean one request per message. The inbox page owns the team session, hydrates
 * once, and any number of bubbles read it for free. Catalog edits made here or
 * by a teammate arrive as `team:catalog:changed` → `useCatalogSync` →
 * `router.refresh()`, which re-runs the page and re-hydrates this list.
 *
 * The mutations return nothing: the resulting chip is rendered by the
 * `message:flag` socket frame flowing through `applyMessageFlag`, exactly like
 * a reaction. No optimistic local state, so there is no reconcile to get wrong.
 */

interface MessageFlagsContextValue {
  definitions: MessageFlagDefinition[];
  raise: (args: {
    messageId: string;
    definitionId: string;
    note?: string;
  }) => Promise<void>;
  setStatus: (flagId: string, status: MessageFlagStatus) => Promise<void>;
  assign: (flagId: string, assignedToId: string | null) => Promise<void>;
  remove: (flagId: string) => Promise<void>;
}

const MessageFlagsContext = createContext<MessageFlagsContextValue | null>(null);

export function MessageFlagsProvider({
  definitions,
  children,
}: {
  definitions: MessageFlagDefinition[];
  children: ReactNode;
}) {
  const raise = useCallback(
    async (args: { messageId: string; definitionId: string; note?: string }) => {
      await mutate("/api/message-flags", "POST", args, "Couldn't flag this message");
    },
    [],
  );

  const setStatus = useCallback(async (flagId: string, status: MessageFlagStatus) => {
    await mutate(
      `/api/message-flags/${flagId}`,
      "PATCH",
      { status },
      "Couldn't update this flag",
    );
  }, []);

  const assign = useCallback(async (flagId: string, assignedToId: string | null) => {
    await mutate(
      `/api/message-flags/${flagId}`,
      "PATCH",
      { assignedToId },
      "Couldn't reassign this flag",
    );
  }, []);

  const remove = useCallback(async (flagId: string) => {
    await mutate(`/api/message-flags/${flagId}`, "DELETE", null, "Couldn't remove this flag");
  }, []);

  const value = useMemo<MessageFlagsContextValue>(
    () => ({ definitions, raise, setStatus, assign, remove }),
    [definitions, raise, setStatus, assign, remove],
  );

  return (
    <MessageFlagsContext.Provider value={value}>{children}</MessageFlagsContext.Provider>
  );
}

/**
 * Read the flag catalog + actions. Returns null outside the provider so
 * callers can render nothing rather than crash — the bubble is also used in
 * surfaces (e.g. the forward preview) that don't mount the inbox providers.
 */
export function useMessageFlags(): MessageFlagsContextValue | null {
  return useContext(MessageFlagsContext);
}

async function mutate(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  fallbackMessage: string,
): Promise<void> {
  try {
    const res = await apiFetch(path, {
      method,
      ...(body === null
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as {
        detail?: string;
        error?: string;
      };
      throw new Error(d.detail || d.error || fallbackMessage);
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : fallbackMessage);
    throw err;
  }
}
