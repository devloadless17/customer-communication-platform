import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REDUCER_EXCLUSIONS,
  THREAD_REDUCER_EVENTS,
  assertReducerCoverage,
} from "../src/features/inbox/lib/thread-reducers";

/**
 * ContactPanel is the third thread-state consumer, and it is DELIBERATELY not
 * wired through the reducer table: it renders from the inbox-shell LRU
 * snapshot (cacheTick-silent while displayed), so it subscribes directly and
 * derives scalar mirrors — the thread-reducers header documents this and
 * forbids "fixing" it by routing through `thread.data` (that re-renders the
 * whole shell per inbound message).
 *
 * What keeps that design honest is `assertReducerCoverage([...])`: every
 * socket event the panel binds must be declared there, so an event outside
 * both contract surfaces throws in dev. This spec is the CI pin for the
 * lockstep the assert can't check itself — that the DECLARED list names every
 * event the component actually binds. Without it, adding a
 * `socket.on("x", …)` without extending the assert list silently reopens the
 * gap the assert exists to close (which is exactly the state this spec was
 * written to end: the contact-edit pair was bound but undeclared).
 */
describe("contact-panel socket coverage", () => {
  const source = readFileSync(
    join(__dirname, "../src/features/inbox/components/contact-panel.tsx"),
    "utf8",
  );

  const bound = [...source.matchAll(/socket\.on\(\s*"([^"]+)"/g)].map((m) => m[1]!);
  const declared = (() => {
    const m = source.match(/assertReducerCoverage\(\[([^\]]+)\]\)/);
    if (!m) return [];
    return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  })();

  it("binds at least the events this design is known to need", () => {
    // Sanity that the regex is scraping the real component, not matching
    // nothing — a refactor that renames the binding pattern must update this
    // spec rather than silently passing on empty sets.
    expect(bound.length).toBeGreaterThanOrEqual(5);
    expect(declared.length).toBeGreaterThanOrEqual(5);
  });

  it("declares every socket event it binds to assertReducerCoverage", () => {
    const undeclared = [...new Set(bound)].filter((e) => !declared.includes(e));
    expect(
      undeclared,
      "contact-panel binds socket event(s) not named in its assertReducerCoverage call — extend the list so the dev invariant covers them",
    ).toEqual([]);
  });

  it("every declared event is inside a contract surface (table or exclusions)", () => {
    // The same check the dev-only assert performs, but running in CI where
    // NODE_ENV isn't production — so a declared event that falls out of both
    // surfaces fails here even if nobody runs the dev server.
    expect(() => assertReducerCoverage(declared)).not.toThrow();
    const known = new Set<string>([
      ...THREAD_REDUCER_EVENTS.map((e) => e.event as string),
      ...REDUCER_EXCLUSIONS.keys(),
    ]);
    for (const e of declared) {
      expect(known.has(e), `${e} is in neither THREAD_REDUCER_EVENTS nor REDUCER_EXCLUSIONS`).toBe(true);
    }
  });
});
