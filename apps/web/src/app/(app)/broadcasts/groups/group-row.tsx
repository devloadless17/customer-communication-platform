"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { TagChip } from "@/features/tags/components/tag-chip";
import type { Tag } from "@ccp/shared/types";
import type { AudienceGroupDto } from "@ccp/shared/dtos";

/**
 * One row in the audience-groups table. The whole row is clickable — pressing
 * anywhere on it opens the group editor. The name stays a real `<a>` so
 * right-click / open-in-new-tab and keyboard nav still work.
 */
export function GroupRow({ group, sampleTags }: { group: AudienceGroupDto; sampleTags: Tag[] }) {
  const router = useRouter();
  const href = `/broadcasts/groups/${group.id}`;
  const extraTagCount = Math.max(0, group.tagIds.length - sampleTags.length);

  return (
    <tr
      onClick={() => router.push(href)}
      className="cursor-pointer border-b border-border last:border-b-0 transition-colors hover:bg-accent/50"
    >
      <td className="max-w-0 px-4 py-3">
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          className="block truncate font-medium text-foreground hover:text-primary"
        >
          {group.name}
        </Link>
        {group.description && (
          <div className="line-clamp-1 text-2xs text-muted-foreground">
            {group.description}
          </div>
        )}
        <div className="truncate text-3xs text-muted-foreground">by {group.createdByName}</div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {sampleTags.map((t) => (
            <TagChip key={t.id} tag={t} size="xs" />
          ))}
          {extraTagCount > 0 && (
            <span className="text-3xs text-muted-foreground">
              +{extraTagCount} tag{extraTagCount === 1 ? "" : "s"}
            </span>
          )}
          {/* manualContactCount, NOT contactIds.length — the list ships only a
              preview slice of the ids so its payload can't grow with a group's
              membership. The count is always exact. */}
          {group.manualContactCount > 0 && (
            <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-3xs font-medium text-violet-700 dark:text-violet-300">
              +{group.manualContactCount} manual
            </span>
          )}
          {sampleTags.length === 0 && group.manualContactCount === 0 && (
            <span className="text-2xs italic text-muted-foreground">Empty</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right font-medium tabular-nums">{group.memberCount}</td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        <LocalTime iso={group.updatedAt} format="listTime" />
      </td>
      <td className="px-4 py-3 text-right">
        <ChevronRight className="ml-auto size-4 text-muted-foreground" />
      </td>
    </tr>
  );
}
