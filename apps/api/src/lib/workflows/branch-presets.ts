import { computeWindowStatus } from "@ccp/shared/utils/window";

import { db } from "@/lib/db";
import type { WorkflowEventEnvelope } from "@/lib/workflows/events";

/**
 * Domain "check" presets for the Branch step. Authors who want to express
 * common decisions ("is the 24h window open?", "does the contact have tag X?")
 * pick a preset instead of authoring a condition group by hand. The runner
 * sees a single Branch step type — only the evaluator differs.
 *
 * Each preset compiles to a deterministic predicate against the runtime
 * envelope. `window_open` is async because it needs `Contact.lastInboundAt`,
 * which isn't on the snapshot today (would be added in PR 2 alongside the
 * snapshot expansion); the rest are pure reads off the envelope.
 */

export type BranchPreset =
  | { type: "window_open" }
  | { type: "has_tag"; tagId: string }
  | { type: "in_stage"; stageId: string }
  | { type: "field_equals"; fieldKey: string; value: string }
  | { type: "message_contains"; needle: string; caseSensitive?: boolean };

export class BranchPresetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchPresetConfigError";
  }
}

export function parseBranchPreset(raw: unknown): BranchPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== "string") return null;
  switch (r.type) {
    case "window_open":
      return { type: "window_open" };
    case "has_tag":
      if (typeof r.tagId !== "string" || !r.tagId) {
        throw new BranchPresetConfigError("has_tag.tagId must be a non-empty string");
      }
      return { type: "has_tag", tagId: r.tagId };
    case "in_stage":
      if (typeof r.stageId !== "string" || !r.stageId) {
        throw new BranchPresetConfigError("in_stage.stageId must be a non-empty string");
      }
      return { type: "in_stage", stageId: r.stageId };
    case "field_equals":
      if (typeof r.fieldKey !== "string" || !r.fieldKey) {
        throw new BranchPresetConfigError("field_equals.fieldKey must be a non-empty string");
      }
      if (typeof r.value !== "string") {
        throw new BranchPresetConfigError("field_equals.value must be a string");
      }
      return { type: "field_equals", fieldKey: r.fieldKey, value: r.value };
    case "message_contains":
      if (typeof r.needle !== "string" || !r.needle) {
        throw new BranchPresetConfigError("message_contains.needle must be a non-empty string");
      }
      return {
        type: "message_contains",
        needle: r.needle,
        ...(r.caseSensitive === true ? { caseSensitive: true } : {}),
      };
    default:
      return null;
  }
}

export function describeBranchPreset(preset: BranchPreset): string {
  switch (preset.type) {
    case "window_open":
      return "If 24h window is open";
    case "has_tag":
      return `If contact has tag ${preset.tagId}`;
    case "in_stage":
      return `If contact in stage ${preset.stageId}`;
    case "field_equals":
      return `If ${preset.fieldKey} = "${preset.value}"`;
    case "message_contains":
      return `If message contains "${preset.needle}"`;
  }
}

/**
 * Evaluate a branch preset against the runtime envelope. Returns true → the
 * "true" outgoing edge fires; false → the "false" edge. Missing data
 * (e.g. no contact on the envelope) returns false — fail closed, matches
 * how `evaluateConditions` treats missing fields.
 */
export async function evaluateBranchPreset(
  preset: BranchPreset,
  envelope: WorkflowEventEnvelope,
): Promise<boolean> {
  const data = envelope.data as {
    contact?: { id?: string; tagIds?: string[]; stageId?: string | null; customFields?: Record<string, string> };
    message?: { body?: string };
  };
  switch (preset.type) {
    case "window_open": {
      const contactId = data.contact?.id;
      if (!contactId) return false;
      // lastInboundAt isn't on the snapshot yet (PR 2 expands it); read
      // the row directly. Cheap — Contact.id is the primary key.
      const row = await db.contact.findUnique({
        where: { id: contactId },
        select: { lastInboundAt: true },
      });
      const iso = row?.lastInboundAt?.toISOString() ?? null;
      return computeWindowStatus(iso).state === "open";
    }
    case "has_tag":
      return (data.contact?.tagIds ?? []).includes(preset.tagId);
    case "in_stage":
      return data.contact?.stageId === preset.stageId;
    case "field_equals":
      return (data.contact?.customFields ?? {})[preset.fieldKey] === preset.value;
    case "message_contains": {
      const body = data.message?.body ?? "";
      if (preset.caseSensitive) return body.includes(preset.needle);
      return body.toLowerCase().includes(preset.needle.toLowerCase());
    }
  }
}
