import "server-only";

// Barrel for `@/lib/queries`. Splits live under this directory by domain so
// edits land in the smallest file possible; the public surface here is
// preserved so import sites don't churn.

export {
  CONVERSATIONS_PAGE,
  MESSAGES_PAGE,
  getConversationWithRefs,
  listConversations,
  listOlderMessages,
} from "./conversations";

export { listTeamMembers } from "./team-members";

export {
  CONTACTS_PAGE,
  countContacts,
  listContactFieldDefinitions,
  listContacts,
  lookupContacts,
} from "./contacts";
export type { ListContactsOpts } from "./contacts";

export {
  getTeamDetailForSuperAdmin,
  listAllTeamsForSuperAdmin,
} from "./super-admin";
export type { SuperAdminTeamDetail, SuperAdminTeamRow } from "./super-admin";

export {
  countAudienceContacts,
  getAudienceGroup,
  listAudienceGroups,
  previewAudienceContacts,
  resolveAudienceGroupMembers,
} from "./audience-groups";
export type { AudienceGroupDto } from "./audience-groups";

export { listTags } from "./tags";
export { listSnippets } from "./snippets";

export {
  loadMessageContextWindow,
  searchConversationMessages,
} from "./search";
export type { MessageSearchHit, MessageSearchPage } from "./search";

export { ensureDefaultStage, listContactStages } from "./stages";
