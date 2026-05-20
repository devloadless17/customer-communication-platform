import type { TagColor } from "../types";

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
  /**
   * Higher-contrast badge variant for stage pills. Where `chip` uses ~10%
   * background opacity (which reads as near-white on light cards), `pill`
   * uses ~22% with a darker text token so the color carries at a distance.
   */
  pill: string;
}

const PALETTE: Record<TagColor, TagColorClasses> = {
  slate: {
    chip: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    swatch: "bg-slate-500",
    solid: "bg-slate-500",
    pill: "border-slate-500/40 bg-slate-500/20 text-slate-800 dark:bg-slate-400/25 dark:text-slate-100",
  },
  rose: {
    chip: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    swatch: "bg-rose-500",
    solid: "bg-rose-500",
    pill: "border-rose-500/40 bg-rose-500/20 text-rose-800 dark:bg-rose-400/25 dark:text-rose-100",
  },
  amber: {
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    swatch: "bg-amber-500",
    solid: "bg-amber-500",
    pill: "border-amber-500/40 bg-amber-500/20 text-amber-800 dark:bg-amber-400/25 dark:text-amber-100",
  },
  emerald: {
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    swatch: "bg-emerald-500",
    solid: "bg-emerald-500",
    pill: "border-emerald-500/40 bg-emerald-500/20 text-emerald-800 dark:bg-emerald-400/25 dark:text-emerald-100",
  },
  sky: {
    chip: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    swatch: "bg-sky-500",
    solid: "bg-sky-500",
    pill: "border-sky-500/40 bg-sky-500/20 text-sky-800 dark:bg-sky-400/25 dark:text-sky-100",
  },
  violet: {
    chip: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    swatch: "bg-violet-500",
    solid: "bg-violet-500",
    pill: "border-violet-500/40 bg-violet-500/20 text-violet-800 dark:bg-violet-400/25 dark:text-violet-100",
  },
  pink: {
    chip: "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300",
    swatch: "bg-pink-500",
    solid: "bg-pink-500",
    pill: "border-pink-500/40 bg-pink-500/20 text-pink-800 dark:bg-pink-400/25 dark:text-pink-100",
  },
  lime: {
    chip: "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300",
    swatch: "bg-lime-500",
    solid: "bg-lime-500",
    pill: "border-lime-500/40 bg-lime-500/20 text-lime-800 dark:bg-lime-400/25 dark:text-lime-100",
  },
  orange: {
    chip: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    swatch: "bg-orange-500",
    solid: "bg-orange-500",
    pill: "border-orange-500/40 bg-orange-500/20 text-orange-800 dark:bg-orange-400/25 dark:text-orange-100",
  },
};

export function tagColorClasses(color: string): TagColorClasses {
  return PALETTE[(color as TagColor) ?? "slate"] ?? PALETTE.slate;
}
