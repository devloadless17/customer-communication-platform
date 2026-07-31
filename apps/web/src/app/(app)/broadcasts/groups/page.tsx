import Link from "next/link";
import { Plus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/current-user";
import { listAudienceGroups, listTags } from "@/lib/api/queries";

import { GroupRow } from "@/features/broadcasts/components/group-row";

export const metadata = { title: "Audience groups" };
export const dynamic = "force-dynamic";

export default async function AudienceGroupsPage() {
  const [{ permissions }, groups, tags] = await Promise.all([
    getSession(),
    listAudienceGroups(),
    listTags(),
  ]);
  const canManage = permissions["audienceGroups:manage"];
  const tagById = new Map(tags.map((t) => [t.id, t] as const));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audience groups</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved lists of contacts for repeat broadcasts. Mix tag-based
            membership with hand-picked contacts.
          </p>
        </div>
        {canManage && (
          <Button asChild>
            <Link href="/broadcasts/groups/new" className="gap-1.5">
              <Plus className="size-4" />
              New group
            </Link>
          </Button>
        )}
      </div>

      {groups.length === 0 ? (
        <EmptyState canManage={canManage} />
      ) : (
        /* Sideways-scroll strip on phones — the table floor (min-w-140 = 35rem)
           overflows narrow viewports, so the wrapper scrolls instead of breaking
           the page layout. w-full keeps desktop full-width. */
        <div className="w-full overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-140 text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Group</th>
                <th className="px-4 py-2.5 text-left font-medium">Composition</th>
                <th className="px-4 py-2.5 text-right font-medium">Members</th>
                <th className="px-4 py-2.5 text-left font-medium">Updated</th>
                <th className="px-4 py-2.5" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRow
                  key={g.id}
                  group={g}
                  sampleTags={g.tagIds
                    .slice(0, 4)
                    .map((id) => tagById.get(id))
                    .filter((t): t is NonNullable<typeof t> => Boolean(t))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmptyState({ canManage }: { canManage: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
      <div className="inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Users className="size-5" />
      </div>
      <div className="text-sm font-medium">No groups yet</div>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        Save a named audience now — pick contacts manually, by tag, or both —
        and reuse it in any future broadcast without re-selecting.
      </p>
      {canManage && (
        <Button asChild className="mt-2">
          <Link href="/broadcasts/groups/new">Create your first group</Link>
        </Button>
      )}
    </div>
  );
}
