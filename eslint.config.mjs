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
