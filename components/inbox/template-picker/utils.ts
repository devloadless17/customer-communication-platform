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

export function countPlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export function renderPlaceholders(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = vars[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}

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
