"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Flag, Settings2, User2 } from "lucide-react";

import {
  SubSidebar,
  SubSidebarItem,
  SubSidebarSection,
} from "@/components/layouts/sub-sidebar";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { MessageFlagCounts, MessageFlagDefinition } from "@ccp/shared/message-flags/types";

/**
 * Flag views.
 *
 * Same shape as the tickets sidebar: views are URL state, so a view is
 * linkable and the back button steps through them, and the sidebar is plain
 * links rather than a second copy of the queue's filter logic.
 *
 * The definition list is SSR-seeded by the page (it's tiny and drives the rail
 * on first paint); only the counts are fetched, and their refetch is coalesced
 * because `message:flag` is a workspace-wide frame — one teammate bulk-triaging
 * would otherwise fire a groupBy per frame per open tab.
 */
export function FlagsSubSidebar({
  definitions,
}: {
  definitions: MessageFlagDefinition[];
}) {
  const params = useSearchParams();
  const [counts, setCounts] = useState<MessageFlagCounts | null>(null);

  const status = params.get("status") ?? "open";
  const mine = params.get("assignee") === "me";
  const definitionId = params.get("definitionId");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await apiFetch("/api/message-flags/counts");
        if (!res.ok) return;
        const body = (await res.json()) as { counts: MessageFlagCounts };
        if (alive) setCounts(body.counts);
      } catch {
        // Best-effort chrome — a failed fetch leaves the last badges.
      }
    };
    void load();
    const socket = getClientSocket();
    const onFlag = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 400);
    };
    socket.on("message:flag", onFlag);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      socket.off("message:flag", onFlag);
    };
  }, []);

  const badge = (n: number | undefined) =>
    n && n > 0 ? (
      <span className="ml-auto shrink-0 tabular-nums text-2xs text-muted-foreground">{n}</span>
    ) : undefined;

  /** Build a href that keeps the other filters intact. */
  const href = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    return qs ? `/flags?${qs}` : "/flags";
  };

  return (
    <SubSidebar title="Flagged">
      <SubSidebarSection>
        <SubSidebarItem
          href={href({ status: null, assignee: null })}
          label="Open"
          leading={<Flag className="size-4" />}
          active={status === "open" && !mine}
          trailing={badge(counts?.totalOpen)}
        />
        <SubSidebarItem
          href={href({ status: null, assignee: "me" })}
          label="Assigned to me"
          leading={<User2 className="size-4" />}
          active={status === "open" && mine}
          trailing={badge(counts?.mineOpen)}
        />
        <SubSidebarItem
          href={href({ status: "resolved", assignee: null })}
          label="Handled"
          leading={<CheckCircle2 className="size-4" />}
          active={status === "resolved"}
        />
      </SubSidebarSection>

      <SubSidebarSection label="Flag type">
        <SubSidebarItem
          href={href({ definitionId: null })}
          label="All flags"
          leading={<Flag className="size-4" />}
          active={definitionId === null}
        />
        {definitions
          .filter((d) => !d.archived)
          .map((d) => (
            <SubSidebarItem
              key={d.id}
              href={href({ definitionId: d.id })}
              label={d.name}
              leading={
                <span
                  aria-hidden
                  className={cn("size-2.5 rounded-full", tagColorClasses(d.color).solid)}
                />
              }
              active={definitionId === d.id}
              trailing={badge(counts?.openByDefinition?.[d.id])}
            />
          ))}
      </SubSidebarSection>

      <SubSidebarSection label="Configure">
        <SubSidebarItem
          href="/settings/message-flags"
          label="Flag types"
          leading={<Settings2 className="size-4" />}
          active={false}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}
