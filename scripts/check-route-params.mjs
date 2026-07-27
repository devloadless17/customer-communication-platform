#!/usr/bin/env node
/**
 * Guard: a Next.js App Router handler must destructure the param names its
 * DIRECTORY actually declares.
 *
 * The bug this exists for (found 2026-07-27, live for 5 days): the
 * org→workspace rename renamed the variable inside
 * `app/api/webhooks/meta/[teamId]/route.ts` — including the `ctx.params`
 * destructure — but left the directory named `[teamId]`. In the App Router the
 * params object's KEYS come from the directory segments, so
 * `const { workspaceId } = await ctx.params` silently yielded `undefined` and
 * every legacy Meta webhook forwarded to `/webhooks/meta/undefined`.
 *
 * TypeScript cannot catch this: the route's own `RouteContext` interface
 * declares whatever the author typed, so the lie is self-consistent. Only the
 * directory name is ground truth — hence this checker.
 *
 * Run: node scripts/check-route-params.mjs   (wired into `pnpm run check`)
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

const ROOT = "apps/web/src/app";

/** Every `route.ts` / `page.tsx` under a dynamic segment. */
async function findHandlers(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      await findHandlers(full, out);
    } else if (e.name === "route.ts" || e.name === "route.tsx") {
      out.push(full);
    }
  }
  return out;
}

/**
 * Param names a path declares, from its `[x]` / `[...x]` / `[[...x]]`
 * segments. Catch-all brackets are stripped to the bare name.
 */
function declaredParams(filePath) {
  return filePath
    .split(sep)
    .filter((seg) => seg.startsWith("[") && seg.endsWith("]"))
    .map((seg) => seg.replace(/^\[+\.{0,3}/, "").replace(/\]+$/, ""));
}

/** Names destructured out of a `params` object in the file. */
function destructuredParams(src) {
  const names = new Set();
  // `const { a, b } = await ctx.params` / `= await params` / `= props.params`
  const re = /const\s*\{([^}]*)\}\s*=\s*(?:await\s+)?[\w.]*\bparams\b/g;
  let m;
  while ((m = re.exec(src))) {
    for (const raw of m[1].split(",")) {
      const name = raw.split(":")[0].trim();
      if (name && !name.startsWith("...")) names.add(name);
    }
  }
  return names;
}

const handlers = await findHandlers(ROOT);
const problems = [];

for (const file of handlers) {
  const declared = declaredParams(file);
  if (declared.length === 0) continue;
  const src = readFileSync(file, "utf8");
  const used = destructuredParams(src);
  for (const name of used) {
    if (!declared.includes(name)) {
      problems.push(
        `${file}\n    destructures "${name}" from params, but the path declares [${declared.join("], [")}]\n` +
          `    → that value is ALWAYS undefined at runtime; typecheck cannot see it.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("✗ route-param check failed:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    "Fix by renaming the DIRECTORY to match, or the destructure to match the directory.\n",
  );
  process.exit(1);
}

console.log(
  `✓ route-param check passed (${handlers.length} handler(s), dynamic segments match their destructures)`,
);
