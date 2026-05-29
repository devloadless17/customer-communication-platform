/**
 * Inbox filter types. The UI for these presets + stage rows lives in
 * `components/layouts/inbox-sub-sidebar.tsx`; this file is types-only so the
 * shape stays colocated with the inbox feature.
 */

export type PresetFilterId = "active" | "all" | "mine" | "unassigned" | "closed";

/**
 * Active inbox filter. Presets and stage filters are mutually exclusive —
 * selecting one clears the other. The discriminated shape lets the
 * conversation list switch on `kind` instead of parsing magic strings, and
 * lets the header render the stage's real name.
 */
export type Filter =
  | { kind: "preset"; id: PresetFilterId }
  | { kind: "stage"; stageId: string };
