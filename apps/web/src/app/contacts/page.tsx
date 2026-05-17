import { getSession } from "@/lib/auth/current-user";
import { canManageContactFields, canManageStages } from "@ccp/shared/auth/permissions";
import {
  listContactFieldDefinitions,
  listContactStages,
  listContacts,
  listTags,
} from "@/lib/api/queries";

import { ContactsClient } from "./contacts-client";

/**
 * Server-render the first page of contacts + the team's field + tag
 * catalogs so every column can render on first paint.
 *
 * `?stage=<id|none>` seeds the stage filter — the settings page links here
 * with that query string to "show me everyone in this stage" before a
 * potential bulk-move.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await getSession();
  const params = await searchParams;
  const stageParam = typeof params.stage === "string" ? params.stage : undefined;

  const [page, fieldDefinitions, tags, stages] = await Promise.all([
    listContacts({
      stageId: stageParam === "none" ? "none" : stageParam || undefined,
    }),
    listContactFieldDefinitions(),
    listTags(),
    listContactStages(),
  ]);

  return (
    <ContactsClient
      initialItems={page.items}
      initialNextCursor={page.nextCursor}
      fieldDefinitions={fieldDefinitions}
      initialTags={tags}
      initialStages={stages}
      initialStageFilter={
        stageParam === "none"
          ? "none"
          : stageParam && stages.some((s) => s.id === stageParam)
            ? stageParam
            : "any"
      }
      canManageFields={canManageContactFields(user.role)}
      canManageStages={canManageStages(user.role)}
    />
  );
}
