import { getSession } from "@/lib/current-user";
import { canManageContactFields } from "@/lib/permissions";
import { listContactFieldDefinitions, listContacts } from "@/lib/queries";

import { ContactsClient } from "./contacts-client";

/**
 * Server-render the first page of contacts + the team's field definitions
 * so the table can render every column on first paint.
 */
export default async function ContactsPage() {
  const { user, teamId } = await getSession();

  const [page, fieldDefinitions] = await Promise.all([
    listContacts(teamId),
    listContactFieldDefinitions(teamId),
  ]);

  return (
    <ContactsClient
      initialItems={page.items}
      initialNextCursor={page.nextCursor}
      fieldDefinitions={fieldDefinitions}
      canManageFields={canManageContactFields(user.role)}
    />
  );
}
