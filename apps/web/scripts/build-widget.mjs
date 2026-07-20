/**
 * Minify the embeddable chat widget for production.
 *
 *   public/widget.js  (SOURCE — readable, commented, served as-is in dev)
 *        ↓ esbuild
 *   public/widget.min.js  (GENERATED — gitignored)
 *
 * Why not minify in place: `widget.js` is the source of truth and its comments are
 * load-bearing documentation (each one records a production failure it prevents).
 * Why not a separate src/ directory: dev would then need a build step before the
 * widget worked at all, and `next dev` serves `public/` verbatim.
 *
 * So the source stays where Next can serve it directly, and production picks up the
 * minified twin through a rewrite in next.config.ts that only activates when this
 * file exists. Nothing to remember, and no way for the two to drift: the min is
 * always regenerated from the source at build time.
 *
 * This script runs from `prebuild`. It is intentionally dependency-light and
 * synchronous — it must never be the reason a deploy fails.
 */
import { transformSync } from "esbuild";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "public", "widget.js");
const OUT = join(here, "..", "public", "widget.min.js");

const source = readFileSync(SRC, "utf8");
const { code } = transformSync(source, {
  minify: true,
  // The widget runs on whatever browser a customer's visitor shows up with, so
  // stay conservative — this is not our own app's audience.
  target: "es2017",
  legalComments: "none",
});

// Cheap sanity gate: a truncated or mangled artifact would break the widget on
// every customer site at once, and it is the one file with no test harness in
// front of it. Both markers are load-bearing entry points.
if (!code.includes("data-webchat-key") || !code.includes("ccp-webchat-root")) {
  throw new Error("[build-widget] minified output is missing expected markers — refusing to write");
}

writeFileSync(OUT, code);

const kb = (n) => (n / 1024).toFixed(1);
console.log(
  `[build-widget] ${kb(statSync(SRC).size)} KB → ${kb(statSync(OUT).size)} KB (widget.min.js)`,
);
