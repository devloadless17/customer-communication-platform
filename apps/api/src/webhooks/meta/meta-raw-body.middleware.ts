/**
 * Marker — the raw body capture lives in main.ts's `bodyParser.json({verify})`
 * configuration. This file exists only to document the contract:
 *
 *   - Express middleware in main.ts attaches `req.rawBody: Buffer` to every
 *     request whose Content-Type is parsed as JSON.
 *   - The Meta webhook controller below reads `req.rawBody` to verify the
 *     HMAC against the exact bytes Meta signed.
 *
 * If main.ts ever stops calling `verify`, Meta signature verification will
 * silently start failing on Phase-1 changes. Keep this file as the trail
 * for grep.
 */
export const RAW_BODY_AVAILABLE = true;
