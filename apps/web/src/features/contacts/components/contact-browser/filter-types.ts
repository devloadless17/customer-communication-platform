import type { ContactSource } from "@ccp/shared/types";

/** Source filter: "all" disables it. */
export type SourceFilter = "all" | ContactSource;

/** 24h customer-service window filter. "any" = no filter. */
export type WindowFilter = "any" | "open" | "closed";

/** Lifecycle stage filter. "any" disables it; "none" = contacts with no stage. */
export type StageFilter = "any" | "none" | string;

/** Single custom-field substring filter. */
export interface FieldFilter {
  key: string;
  value: string;
}
