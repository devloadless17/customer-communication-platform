import { getSession } from "@/lib/auth/current-user";
import {
  listContactFieldsWithBuiltins,
  listContactStages,
  listContacts,
  listTags,
} from "@/lib/api/queries";

import { ContactsClient } from "./contacts-client";
import type { StageFilter } from "@/features/contacts/components/contact-browser";

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
  const { permissions } = await getSession();
  const params = await searchParams;
  const stageParam = typeof params.stage === "string" ? params.stage : undefined;

  const [page, fieldsAndBuiltins, tags, stages] = await Promise.all([
    listContacts({
      stageId: stageParam === "none" ? "none" : stageParam || undefined,
    }),
    listContactFieldsWithBuiltins(),
    listTags(),
    listContactStages(),
  ]);
  const { definitions: fieldDefinitions, builtins: contactPanelBuiltins } =
    fieldsAndBuiltins;

  const resolvedStageFilter: StageFilter =
    stageParam === "none"
      ? "none"
      : stageParam && stages.some((s) => s.id === stageParam)
        ? stageParam
        : "any";

  // Key by the resolved stage filter so a sidebar click (which is a soft nav
  // between two /contacts?stage=… URLs) forces ContactsClient to remount with
  // the new SSR-seeded items + stage filter. Without this, `useContactList`'s
  // useState initializers latch the first stage filter forever and the
  // sidebar appears to do nothing.
  return (
    <ContactsClient
      key={resolvedStageFilter}
      initialItems={page.items}
      initialNextCursor={page.nextCursor}
      fieldDefinitions={fieldDefinitions}
      contactPanelBuiltins={contactPanelBuiltins}
      initialTags={tags}
      initialStages={stages}
      initialStageFilter={resolvedStageFilter}
      canManageFields={permissions["contactFields:manage"]}
      canManageStages={permissions["stages:manage"]}
      canDeleteContacts={permissions["contacts:delete"]}
    />
  );
}
