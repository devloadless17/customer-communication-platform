import type { Channel, ContactSource } from "@ccp/shared/types";

/** Source filter: "all" disables it. */
export type SourceFilter = "all" | ContactSource;

/** Channel filter: "any" disables it; else one channel identity. */
export type ChannelFilter = "any" | Channel;

/** How you can reach a contact. "any" disables the gate.
 *  The contacts directory defaults to "phone" — "everyone I can call" — while a
 *  channel segment lifts it, and "email" is the shape an email campaign wants. */
export type ReachFilter = "any" | "phone" | "email";

/** 24h customer-service window filter. "any" = no filter. */
export type WindowFilter = "any" | "open" | "closed";

/** Lifecycle stage filter. "any" disables it; "none" = contacts with no stage. */
export type StageFilter = "any" | "none" | string;

/** Single custom-field filter. Default mode is substring (`contains`);
 *  select-type fields send `equals` with `value` = the option ID. */
export interface FieldFilter {
  key: string;
  value: string;
  mode?: "contains" | "equals";
}
