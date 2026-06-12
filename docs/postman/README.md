# Organization API — Postman collection

Ready-to-use Postman collection for the per-organization External API (`/api/external/v1`).
One API key per organization; it scopes every request to that org automatically.

## Files

- `ccp-org-api.postman_collection.json` — all 35 endpoints, grouped into folders (incl. AI Autopilot toggle).
- `ccp-local.postman_environment.json` — `baseUrl` + `apiKey` + id variables for local dev.

## Setup (60 seconds)

1. **Import both files** into Postman (Import → drag both in).
2. Top-right environment selector → choose **CCP — Local (dev)**.
3. Open the environment, set **apiKey** to your org's key (app → Settings → Integrations → create an API key; it starts with `ccp_`). Save.
4. For production, set **baseUrl** to `https://<your-host>` (no port — Caddy fronts it).

That's it. Every request inherits Bearer auth from `{{apiKey}}` — no per-request setup.

## Using it

- Start with **Catalog → List …** and **Contacts / Conversations → List …** to discover ids, then paste them into the matching environment variables (`conversationId`, `contactId`, `tagId`, `stageId`, `userIdOrEmail`).
- **Sends** (`Send message …`) require an `Idempotency-Key`; those requests pre-fill it with a fresh UUID (`{{$guid}}`) per click so retries can't double-send.

## Good to know (WhatsApp specifics)

- **24-hour window:** free-form text sends only reach a customer who messaged you in the last 24h. Outside it, use a **template** (see the body note on *Send message (by contact / phone)*).
- **Scopes:** each endpoint needs a capability on the key (`read:contacts`, `write:messages`, `write:catalog`, …). A key created with `*` (all scopes) works everywhere. A `403` means the key lacks that scope.
- **Channel-agnostic addressing:** prefer `conversationId` (replies) or `contact.id` (cold) over `phone` — those work unchanged if a second channel (e.g. Instagram) is ever added.
