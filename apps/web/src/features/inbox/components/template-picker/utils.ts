export function labelCategory(c: string): string {
  switch (c) {
    case "marketing":
      return "Marketing";
    case "utility":
      return "Utility";
    case "authentication":
      return "Auth";
    default:
      return c;
  }
}

// Placeholder rendering/counting is shared with the server (it stores the
// rendered body) so the optimistic preview can't drift — see
// @ccp/shared/template-render. Re-exported under the picker's local names so
// existing call sites stay unchanged.
export {
  countTemplatePlaceholders as countPlaceholders,
  renderTemplateBody as renderPlaceholders,
} from "@ccp/shared/template-render";

export function firstEmptyIndex(values: string[]): number {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!v || v.length === 0) return i;
  }
  return 0;
}

export function extractExample(arr: string[] | undefined, i: number): string | undefined {
  if (!arr) return undefined;
  const v = arr[i];
  return v && v.length > 0 ? v : undefined;
}
