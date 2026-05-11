import Link from "next/link";
import { ChevronRight, Plus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TagChip } from "@/components/tags/tag-chip";
import { getSession } from "@/lib/current-user";
import { listAudienceGroups, listTags } from "@/lib/queries";
import { formatListTime } from "@/lib/utils";

export const metadata = { title: "Audience groups" };
export const dynamic = "force-dynamic";

export default async function AudienceGroupsPage() {
  const { teamId } = await getSession();
  const [groups, tags] = await Promise.all([
    listAudienceGroups(teamId),
    listTags(teamId),
  ]);
  const tagById = new Map(tags.map((t) => [t.id, t] as const));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* In-page tabs between Broadcasts and Groups so they read as
              two views of the same area (saved audiences + past sends). */}
          <Link
            href="/broadcasts"
            className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Broadcasts
          </Link>
          <Link
            href="/broadcasts/groups"
            className="rounded-md bg-accent px-2.5 py-1.5 text-sm font-medium text-foreground"
          >
            Groups
          </Link>
        </div>
        <Button asChild>
          <Link href="/broadcasts/groups/new" className="gap-1.5">
            <Plus className="size-4" />
            New group
          </Link>
        </Button>
      </header>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audience groups</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Saved lists of contacts for repeat broadcasts. Mix tag-based
          membership with hand-picked contacts.
        </p>
      </div>

      {groups.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Group</th>
                <th className="px-4 py-2.5 text-left font-medium">Composition</th>
                <th className="px-4 py-2.5 text-right font-medium">Members</th>
                <th className="px-4 py-2.5 text-left font-medium">Updated</th>
                <th className="px-4 py-2.5" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const sampleTags = g.tagIds
                  .slice(0, 4)
                  .map((id) => tagById.get(id))
                  .filter((t): t is NonNullable<typeof t> => Boolean(t));
                const extraTagCount = Math.max(0, g.tagIds.length - sampleTags.length);
                return (
                  <tr
                    key={g.id}
                    className="border-b border-border last:border-b-0 hover:bg-accent/30"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/broadcasts/groups/${g.id}`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {g.name}
                      </Link>
                      {g.description && (
                        <div className="line-clamp-1 text-[11px] text-muted-foreground">
                          {g.description}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        by {g.createdByName}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        {sampleTags.map((t) => (
                          <TagChip key={t.id} tag={t} size="xs" />
                        ))}
                        {extraTagCount > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{extraTagCount} tag{extraTagCount === 1 ? "" : "s"}
                          </span>
                        )}
                        {g.contactIds.length > 0 && (
                          <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                            +{g.contactIds.length} manual
                          </span>
                        )}
                        {sampleTags.length === 0 && g.contactIds.length === 0 && (
                          <span className="text-[11px] italic text-muted-foreground">
                            Empty
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      {g.memberCount}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-muted-foreground">
                      {formatListTime(g.updatedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/broadcasts/groups/${g.id}`}
                        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Open group"
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
      <div className="inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Users className="size-5" />
      </div>
      <div className="text-sm font-medium">No groups yet</div>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Save a named audience now — pick contacts manually, by tag, or both —
        and reuse it in any future broadcast without re-selecting.
      </p>
      <Button asChild className="mt-2">
        <Link href="/broadcasts/groups/new">Create your first group</Link>
      </Button>
    </div>
  );
}
