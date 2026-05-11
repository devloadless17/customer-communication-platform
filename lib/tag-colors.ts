import type { TagColor } from "@/lib/types";

/**
 * Safelist of Tailwind classes for each TagColor. Defined as static string
 * literals so Tailwind's CSS scanner sees every class — dynamic `bg-${color}`
 * strings get pruned by the JIT compiler.
 *
 *   - `chip`    → tag chip background + text + border (light + dark)
 *   - `swatch`  → small dot in the picker / color selector
 *
 * Adding a new color: append to TAG_COLORS in lib/types.ts AND add a row
 * here. The runtime falls back to `slate` if a row is missing.
 */

interface TagColorClasses {
  chip: string;
  swatch: string;
  /** Solid background for the color picker preview / selected state. */
  solid: string;
}

const PALETTE: Record<TagColor, TagColorClasses> = {
  slate: {
    chip: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    swatch: "bg-slate-500",
    solid: "bg-slate-500",
  },
  rose: {
    chip: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    swatch: "bg-rose-500",
    solid: "bg-rose-500",
  },
  amber: {
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    swatch: "bg-amber-500",
    solid: "bg-amber-500",
  },
  emerald: {
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    swatch: "bg-emerald-500",
    solid: "bg-emerald-500",
  },
  sky: {
    chip: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    swatch: "bg-sky-500",
    solid: "bg-sky-500",
  },
  violet: {
    chip: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    swatch: "bg-violet-500",
    solid: "bg-violet-500",
  },
  pink: {
    chip: "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300",
    swatch: "bg-pink-500",
    solid: "bg-pink-500",
  },
  lime: {
    chip: "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300",
    swatch: "bg-lime-500",
    solid: "bg-lime-500",
  },
  orange: {
    chip: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    swatch: "bg-orange-500",
    solid: "bg-orange-500",
  },
};

export function tagColorClasses(color: string): TagColorClasses {
  return PALETTE[(color as TagColor) ?? "slate"] ?? PALETTE.slate;
}
