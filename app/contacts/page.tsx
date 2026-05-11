import { getSession } from "@/lib/current-user";
import { canManageContactFields } from "@/lib/permissions";
import { listContactFieldDefinitions, listContacts, listTags } from "@/lib/queries";

import { ContactsClient } from "./contacts-client";

/**
 * Server-render the first page of contacts + the team's field + tag
 * catalogs so every column can render on first paint.
 */
export default async function ContactsPage() {
  const { user, teamId } = await getSession();

  const [page, fieldDefinitions, tags] = await Promise.all([
    listContacts(teamId),
    listContactFieldDefinitions(teamId),
    listTags(teamId),
  ]);

  return (
    <ContactsClient
      initialItems={page.items}
      initialNextCursor={page.nextCursor}
      fieldDefinitions={fieldDefinitions}
      initialTags={tags}
      canManageFields={canManageContactFields(user.role)}
    />
  );
}
