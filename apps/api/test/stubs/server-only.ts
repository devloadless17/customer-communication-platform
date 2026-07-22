/**
 * No-op stand-in for the `server-only` package under Vitest.
 *
 * `server-only` exists to make Next.js FAIL THE BUILD if a server module is
 * pulled into a Client Component bundle. Vitest is neither — it runs these
 * modules in Node, exactly where they're meant to run — but the real package
 * throws on import regardless, which blocks unit-testing anything downstream of
 * (say) the envelope-crypto module. Aliasing it here keeps the guard fully
 * intact for the actual Next.js build.
 */
export {};
