/**
 * Deterministic gradient palette for avatar fallbacks.
 *
 * Same input → same colors, every render and every browser. Without this we
 * either need real profile pictures (which Meta Cloud API doesn't expose) or
 * we live with gray initials, which makes a list of 50 contacts feel like
 * gray soup.
 *
 * Tradeoff: HSL-based palette over a curated swatch set. A swatch set looks
 * a touch more "designed" but adds collisions when the swatch count is
 * smaller than the contact count. HSL trades a little harmony for guaranteed
 * dispersion.
 */

const SATURATION = 62;
const LIGHTNESS_FROM = 48;
const LIGHTNESS_TO = 38;

function hash(input: string): number {
  // FNV-ish 32-bit. Plenty for a palette pick; not crypto.
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * CSS `background-image` value with a two-stop linear gradient. Apply via
 * `style={{ backgroundImage: avatarGradient(seed) }}` on AvatarFallback.
 */
export function avatarGradient(seed: string): string {
  const h = hash(seed);
  const hueA = h % 360;
  // Second stop sits ~40° away on the hue wheel for visible motion without
  // clashing — too far apart and the gradient muddies through complementary
  // gray tones.
  const hueB = (hueA + 40) % 360;
  return `linear-gradient(135deg, hsl(${hueA} ${SATURATION}% ${LIGHTNESS_FROM}%), hsl(${hueB} ${SATURATION}% ${LIGHTNESS_TO}%))`;
}
