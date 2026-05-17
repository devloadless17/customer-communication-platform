/**
 * NOT a real middleware — marker file only.
 *
 * The raw body capture lives in apps/api/src/main.ts's
 * `bodyParser.json({ verify })` configuration. The `verify` callback
 * attaches `req.rawBody: Buffer` to every request whose URL starts with
 * `/webhooks/`. The Meta webhook controller below reads `req.rawBody` to
 * verify HMAC against the exact bytes Meta signed.
 *
 * Two reasons to grep this filename:
 *   1. Find the rawBody contract (this comment, then main.ts).
 *   2. Find the test surface — the controller's signature check is the
 *      only consumer of req.rawBody in the codebase.
 *
 * If main.ts ever stops calling `verify`, or scopes it to a path that
 * doesn't include /webhooks/, Meta signature verification silently
 * starts failing. Keep this file as the trail for grep.
 */
export const RAW_BODY_AVAILABLE = true;
