import "server-only";



import { api } from "../../api-client";
import type {
  ListContactsOpts,
} from "@ccp/shared/dtos";
import type {
  Contact,
  ContactListItem,
  CursorPage,
} from "@ccp/shared/types";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function listContacts(
  opts: ListContactsOpts = {},
): Promise<CursorPage<ContactListItem>> {
  return api<CursorPage<ContactListItem>>("/api/contacts", {
    query: {
      search: opts.search,
      cursor: opts.cursor ?? undefined,
      // Numbered (offset) pagination — the /contacts page seeds page 1 in this
      // mode so the SSR rows match the paginated client (see contacts/page.tsx).
      page: opts.page,
      take: opts.take,
      fieldKey: opts.fieldFilter?.key,
      fieldValue: opts.fieldFilter?.value,
      source: opts.source,
      tagIds: opts.tagIds && opts.tagIds.length > 0 ? opts.tagIds.join(",") : undefined,
      window: opts.window,
      stageId: opts.stageId,
    },
  });
}

export async function countContacts(audience: {
  tagIds?: string[];
  contactIds?: string[];
}): Promise<number> {
  const { count } = await api<{ count: number }>("/api/contacts/count", {
    method: "POST",
    body: {
      tagIds: audience.tagIds ?? [],
      contactIds: audience.contactIds ?? [],
    },
  });
  return count;
}

/**
 * Total contacts in the team — distinct from `countContacts` which resolves an
 * audience union (returns 0 for an empty filter, by design). Used by the
 * broadcast wizard's "All contacts" card so the recipient count reads the
 * real team size, not 0.
 */
export async function countAllContacts(): Promise<number> {
  const { count } = await api<{ count: number }>("/api/contacts/count-all", {
    method: "GET",
  });
  return count;
}

export async function lookupContacts(ids: string[]): Promise<Contact[]> {
  if (ids.length === 0) return [];
  const { contacts } = await api<{ contacts: Contact[] }>("/api/contacts/lookup", {
    query: { ids: ids.join(",") },
  });
  return contacts;
}

