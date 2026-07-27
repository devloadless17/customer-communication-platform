import { Controller, Get, Query, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zQuery } from "../common/zod-validation.pipe";
import { RateLimit } from "../common/rate-limit.interceptor";
import { ConversationsService } from "./conversations.service";
import {
  GlobalSearchQuerySchema,
  type GlobalSearchQuery,
} from "./conversations.schemas";

/**
 * GLOBAL inbox search — backs the tabbed search bar over the conversation
 * list. One endpoint, `scope`-dispatched; the response shape differs per
 * scope and the client requests exactly the tab it's rendering:
 *
 *   GET /api/inbox/search?scope=contacts&q=… → ContactSearchPage
 *   GET /api/inbox/search?scope=messages&q=… → GlobalMessageSearchPage
 *   GET /api/inbox/search?scope=notes&q=…    → NoteSearchPage
 *
 * All three are team-scoped (session.workspaceId), read-only, and ungated beyond
 * SessionGuard — same access level as the conversation list itself (any
 * member can search the inbox they can already see). Empty/blank `q`
 * short-circuits to an empty page so the client can fire on every keystroke
 * without a special-case.
 */
@Controller("api/inbox/search")
@UseGuards(SessionGuard)
// Read-tier limit on its own bucket (see ConversationsController) — the client
// fires this on every keystroke of the global search bar, so the 300/min
// default would 429 an agent typing a query. Cheap, team-scoped, read-only.
@RateLimit({ perMinute: 1200 })
export class InboxSearchController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  async search(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(GlobalSearchQuerySchema)) query: GlobalSearchQuery,
  ) {
    const q = (query.q ?? "").trim();
    if (q.length === 0) return { items: [], nextCursor: null };

    const opts = {
      query: q,
      take: query.take,
      cursor: query.cursor,
      accountId: query.accountId ?? null,
    };
    switch (query.scope) {
      case "contacts":
        return this.conversations.globalSearchContacts(session.workspaceId, opts, session);
      case "messages":
        // minor#14: the heavy scopes are team-wide trigram/ILIKE scans over the
        // Message table — a 1-char query matches half the team and seq-scans.
        // The web client already gates these at >=2 chars (the search panel only
        // mounts at length>=2); enforce the same floor server-side so a direct
        // API call (or a future client) can't trigger the scan on 1-char input.
        if (q.length < 2) return { items: [], nextCursor: null };
        return this.conversations.globalSearchMessages(session.workspaceId, opts, session);
      case "notes":
        if (q.length < 2) return { items: [], nextCursor: null };
        return this.conversations.globalSearchNotes(session.workspaceId, opts, session);
    }
  }
}
