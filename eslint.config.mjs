// Flat ESLint config (ESLint 9) for the whole pnpm workspace. One root config,
// run from the repo root via `pnpm lint` (= `eslint .`). Replaces the removed
// `next lint` (Next 16 dropped that subcommand) so linting is consistent across
// apps/web (Next 16), apps/api (NestJS 11), and packages/*.
//
// Philosophy: catch real correctness bugs as ERRORS, surface style/maintenance
// nudges as WARNINGS (warnings don't fail `eslint .`). tsc already enforces
// strict typing + unused symbols, so we don't duplicate that as build-blocking.

import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ---- Ignore generated / vendored / build output --------------------------
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "apps/web/next-env.d.ts",
      // Claude Code tooling, not app source. Persisted Workflow scripts (.mjs)
      // use runtime-injected globals (agent/parallel/log/phase) that aren't
      // real JS, so `eslint .` would flag them as no-undef. The committed
      // skills/ assets here are Markdown/CSV/Python — none of them ours to lint.
      ".claude/**",
    ],
  },

  // ---- Base JS + TS recommended (all source) -------------------------------
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- Defaults for every TS/TSX file --------------------------------------
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // TypeScript resolves identifiers itself; core `no-undef` produces false
      // positives on types/globals in .ts. typescript-eslint's own guidance is
      // to disable it for TS files.
      "no-undef": "off",
      // tsc enforces unused symbols (noUnusedLocals/Parameters) at build time;
      // keep eslint's as a warning with the conventional underscore escape
      // hatch so it nudges in-editor without duplicating build failures.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The provider / adapter / event-bus seams use `any` deliberately in a
      // handful of spots; flagging every one as an error isn't actionable here.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ---- Web app: React hooks + Next.js rules + browser globals --------------
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // App Router only — there is no pages/ dir, so this rule otherwise emits
      // a noisy "Pages directory cannot be found" message on every run.
      "@next/next/no-html-link-for-pages": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Nudge bare `fetch("/api/...")` callers toward the centralized
      // wrapper at `lib/api/client-fetch.ts` (apiFetch / fetchWithSessionGuard).
      // The wrapper covers cross-port dev (BROWSER_API_BASE), cookie
      // forwarding, and the session-expiry guard that routes stale-cookie
      // requests to /logout. Bare fetch papers over all three; new code
      // copying that pattern is the slow drift toward "session expired
      // toasts instead of redirects." Warning, not error — migration is
      // opportunistic per the wrapper's doc-comment; an error would
      // block every PR until the legacy sites are converted.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "CallExpression[callee.name='fetch'][arguments.0.type='Literal'][arguments.0.value=/^\\/api\\//]",
          message:
            "Use apiFetch / fetchWithSessionGuard from @/lib/api/client-fetch instead of bare fetch() for internal /api/* calls — it handles cross-port dev, cookie forwarding, and stale-session redirects.",
        },
        {
          selector:
            "CallExpression[callee.name='fetch'][arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.raw=/^\\/api\\//]",
          message:
            "Use apiFetch / fetchWithSessionGuard from @/lib/api/client-fetch instead of bare fetch() for internal /api/* calls — it handles cross-port dev, cookie forwarding, and stale-session redirects.",
        },
      ],
    },
  },

  // ---- Files that MUST call bare fetch (would otherwise forbid their own
  // ---- implementation or self-recurse through the wrapper). ------------
  //   - client-fetch.ts IS the apiFetch wrapper.
  //   - client-session-guard.ts is the 401 handler apiFetch delegates to; its
  //     own session-validation probe (`/api/auth/get-session`) can't go through
  //     apiFetch without infinite recursion (apiFetch → session-guard → apiFetch).
  {
    files: [
      "apps/web/src/lib/api/client-fetch.ts",
      "apps/web/src/lib/auth/client-session-guard.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },

  // ---- API: type-aware linting for the floating/misused-promise class ------
  // The base config above is syntax-only, so a dropped `await` (e.g. fire-and-
  // forget a Meta send / DB write inside an async handler) goes uncaught. Turn
  // on the TS type-checker for the NestJS source + the framework-agnostic libs
  // it shares, and enable the two promise-correctness rules. Scoped to these
  // globs (all covered by apps/api/tsconfig.json) so `projectService` always
  // resolves a project and never errors on an out-of-project file. Set to
  // `warn` to surface without failing `eslint .` while the existing backlog is
  // burned down — promote to `error` once clean.
  {
    files: ["apps/api/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
    },
  },

  // ---- Config / script / seed files: Node context, allow CJS-ish patterns --
  {
    files: ["**/*.config.{js,mjs,ts}", "scripts/**/*.{ts,js}", "prisma/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
