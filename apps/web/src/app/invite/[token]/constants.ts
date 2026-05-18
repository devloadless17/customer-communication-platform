/**
 * Cookie marker so the auto-revalidated invite page can tell "this browser
 * just accepted" from "stale visitor on a used link" — without depending on
 * getCurrentSession() during revalidation, which sees the *original*
 * request headers (no cookie) and so always reports anonymous.
 *
 * Lives in its own file (not actions.ts) because Next.js forbids non-
 * function exports from `"use server"` modules — exporting a string
 * constant alongside server actions silently drops every export from the
 * module and breaks `next build`.
 */
export const INVITE_JUST_ACCEPTED_COOKIE = "invite-just-accepted";
