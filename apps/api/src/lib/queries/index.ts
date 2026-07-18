// Barrel for `@/lib/queries`. Splits live under this directory by domain so
// edits land in the smallest file possible; the public surface here is
// preserved so import sites don't churn.

export {
  ATTACHMENTS_PAGE,
  CONVERSATIONS_PAGE,
  MESSAGES_PAGE,
  getConversationWithRefs,
  listConversationAttachments,
  listConversationEvents,
  listConversations,
  listNewerMessages,
  listOlderMessages,
} from "./conversations";

export {
  CONTACTS_PAGE,
  buildContactFilterWhere,
  countContacts,
  listContactFieldDefinitions,
  listContacts,
  listPeople,
  lookupContacts,
  resolveContactIdsByFilter,
} from "./contacts";
export type { ListContactsOpts } from "./contacts";

export {
  getPlatformAnalytics,
  getTeamDetailForSuperAdmin,
  invalidateSuperAdminAggregates,
  listAllTeamsForSuperAdmin,
} from "./super-admin";
export type {
  PlatformAnalytics,
  SuperAdminTeamDetail,
  SuperAdminTeamRow,
} from "./super-admin";

export {
  countAudienceContacts,
  getAudienceGroup,
  listAudienceGroups,
  previewAudienceContacts,
  resolveAudienceGroupMembers,
} from "./audience-groups";
export type { AudienceGroupDto } from "./audience-groups";

export {
  loadMessageContextWindow,
  searchConversationMessages,
} from "./search";
export type { MessageSearchHit, MessageSearchPage } from "./search";

export {
  searchAllMessages,
  searchAllNotes,
  searchContacts,
} from "./global-search";

export { ensureDefaultStage, listContactStages } from "./stages";

// The single Contact wire serializer — use for every contact.created/updated
// payload instead of hand-rolling a literal (hand-rolled copies dropped
// callPermissionRevokedUntil; see _shared.ts).
export { toContactWire } from "./_shared";
