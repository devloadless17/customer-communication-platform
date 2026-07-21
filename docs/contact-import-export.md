# Contact import & export

CSV and Excel, both directions, built to be correct and boring at 100,000 contacts on the single 8 GB VPS (CLAUDE.md §16).

---

## Shape of the thing

```
UI / /v1  →  ContactTransferJob row  →  contact-transfer queue  →  worker
                                                                    ├─ export-runner  → R2 artifact → presigned download
                                                                    └─ import-runner  → batched writes + error report
```

Both directions are **asynchronous jobs**, always — there is no "small enough to do inline" fast path, because two code paths for one feature is how the two drift. A tiny team's export finishes in well under a second and the download auto-starts; a 100k export takes ~11s and survives the user closing the tab.

| Concern | Where |
|---|---|
| Format seam (CSV ↔ Excel) | `apps/api/src/lib/contact-transfer/formats.ts` |
| Column table (shared with the browser) | `packages/shared/src/contacts/transfer-columns.ts` |
| Team column resolution + header mapping | `apps/api/src/lib/contact-transfer/columns.ts` |
| Export | `apps/api/src/lib/contact-transfer/export-runner.ts` |
| Import | `apps/api/src/lib/contact-transfer/import-runner.ts` |
| Queue + worker | `.../queue.ts`, `.../worker.ts` |
| HTTP seam | `apps/api/src/contacts/transfer.{controller,service,schemas}.ts` |
| Artifact expiry / stalled runs | `apps/api/src/lib/sweepers/contact-transfer-artifacts.ts` |
| UI | `apps/web/src/features/contacts/components/transfer/**` |
| `/v1` parity | `apps/api/src/external/v1/**` · [docs/organization-api.md](organization-api.md) · in-app `/docs/api` |

---

## The format seam

Everything above `formats.ts` works on `Row = Record<string, string>` and never branches on CSV-vs-Excel. Two tiny interfaces — `RowSink` (header, chunks, finish) and `RowSource` (headers, async rows) — with a CSV and an XLSX implementation of each. A third format is one new sink + one new source and **zero** changes to the runners. Same discipline `MessagingProvider` gives us for channels (§5).

`csvSink` delegates to the existing `csvHeader`/`csvRows` in `lib/csv.ts` so `escapeCell`'s OWASP formula-injection defuse stays a single implementation — contact names come from inbound WhatsApp and from imported files, both attacker-controlled.

### Excel gotchas that are handled (and were measured, not assumed)

`cellToString()` in `formats.ts` is where naive spreadsheet importers break:

| Input | Naive result | What we do |
|---|---|---|
| A phone typed into Excel (`15551234567`) is stored as a **Number** | `"1.5551234567e+10"` → every row fails phone validation | `toFixed(0)`, full digits |
| Formula cell | `"[object Object]"` | read the cached `.result` |
| Rich text (`"Ali " + "Ahmad"` across two runs) | `"AliAhmad"` — trimming each run eats the space | concatenate raw, trim once |
| Date cell | with `styles: "ignore"` ExcelJS returns the raw serial `43832.1278` | `styles: "cache"` → a real `Date` → ISO |
| Error cell (`#N/A`) | `"[object Object]"` | empty |
| `row.values` | 1-indexed with a hole at `[0]` | sliced |

**`styles: "cache"` is load-bearing** for dates and was found by measurement. **`useSharedStrings: false`** on the writer is load-bearing for memory — the shared-string table holds every distinct string in the workbook for the process lifetime, which is exactly the unbounded growth streaming exists to avoid.

### Custom fields whose label collides with a built-in

A team can own a custom field labelled "Language" or "City" — the reserved-name
guard rejects those at create time on the internal route, but pre-guard rows
exist (this repo's own dev DB had one) and `/v1` was missing the guard entirely
until 2026-07-21.

Such a field is a round-trip hazard: every header spelling of it resolves to the
built-in column first, so a naive export writes TWO columns (`language` and
`Language`) that both land in the built-in on re-import — last one wins, and the
custom field's data is silently replaced.

Handled with a header prefix: a colliding field is written as
**`custom:<key>`**, and `resolveImportMapping` resolves that form *before*
built-in matching. Non-colliding custom fields keep their plain, human-readable
label. `fieldHeader()` in `columns.ts` is the single place that decides.

---

## Import

**Identity.** Every imported row is keyed on a normalized phone and stamped `identityChannel: 'whatsapp'` — the only channel whose natural key a person can type into a spreadsheet (social channels key on a vendor-issued `externalContactId`). An imported **email is stored but never used as an identity key**: `IdentityService` only trusts email when self-asserted through the contact-share chip. A hand-typed address in a spreadsheet cannot fold two customers into one. See [identity.md](identity.md).

**Write modes** — `create_only` (default, the historical behavior) · `create_and_update` · `update_only`.

The upsert is ONE `UPDATE … FROM UNNEST(...)` per batch. The load-bearing detail:

```sql
name = COALESCE(NULLIF(v.name, ''), c.name)
```

**A blank cell leaves the existing value alone.** Anything else means a user who exports, edits one column in Excel, and re-imports wipes every field their spreadsheet didn't happen to include — the single most destructive thing a contact importer can do. `version = version + 1` always, so an in-flight PATCH CAS-fails rather than silently overwriting the import.

**The automations gate.** Per-row `contact.created`/`contact.updated` drive workflow dispatch and outbound-webhook delivery. At 100k rows that is 100k `OutboundEvent` inserts, 100k workflow runs and 100k HTTP deliveries — the same failure mode the "never subscribe audit or workflow to `broadcast.*`" invariant exists to prevent (§9). So:

- **≤ `IMPORT_EVENT_FANOUT_CAP` (5,000) rows** → per-row events publish exactly as before, with `suppressSocketFanout: true`. Small imports are byte-identical to the old behavior.
- **above it** → no per-row events, `automationsSkipped = true` on the job, and the UI says so plainly. A silent skip would read as broken automations.

Either way, one coalesced `contact.bulk_updated` refreshes every open contacts list.

**Resume.** `processedRows` on the job row is the cursor; a retry skips rows below it and counters advance only after a batch commits, so a mid-run crash can't double-count. Every write is independently idempotent anyway (`createMany skipDuplicates`, the revive CAS, `ON CONFLICT DO NOTHING`).

**Error report.** Failed rows are written to a second artifact **in the format the user uploaded**, carrying their original cells plus `_row` and `_error`. Fix and re-import that file directly — no diffing a summary against a spreadsheet to find which of 100,000 rows was rejected.

**Caps** — 50 MB upload · 200,000 rows · 100 new tags auto-created per import · 100 custom-field columns · 50,000 rows in the error report.

---

## Export

Keyset-paginated (`PAGE = 2000`) over `buildContactFilterWhere` — the **same** predicate the contacts list, the count endpoint, and filter-mode bulk actions use, so an export matches exactly what the user is looking at. `directoryContactWhere` still applies, so anonymous webchat visitors stay out.

The one-off `customFields` bag keys become columns via a single `SELECT DISTINCT jsonb_object_keys(...)` pre-pass (capped at 200) — the old exporter collected them while iterating every row, which a streaming export can't do because the header ships first.

Scope is `ids` (an explicit selection) → wins over `filters` → falls back to the whole directory.

---

## Safety

- **Tenant isolation.** Job reads are `findFirst({ where: { id, teamId } })` so a foreign id 404s rather than 403-ing with a leak. The staged `uploadKey` is client-supplied, so it is checked against the team's own `contact-imports/<teamId>/` prefix before the worker is ever pointed at it.
- **Artifacts expire after 7 days.** A contact export is the whole address book in one file; the sweeper deletes the objects (before the rows, so a failure retries rather than orphaning) and fails any `running` job whose heartbeat is >15 min stale.
- **Downloads are 302s to short-lived (5 min) presigned URLs.** R2 keys are never exposed in a response body.
- **Concurrency** — `MAX_CONCURRENT_TRANSFERS_PER_TEAM = 1` (a 409, not a silent queue) **and** `MAX_CONCURRENT_TRANSFERS = 2` process-wide. Both levels deliberately: the recurring defect in this codebase's queues has been a per-tenant cap with no process-wide ceiling.
- **Uploads use multer disk storage**, not memory — a 50 MB Buffer per concurrent upload is heap this container has no reason to spend.
- **Format is sniffed from content** (`PK` = xlsx), not the filename; a legacy `.xls` (OLE2) is refused with an actionable message instead of failing deep inside a batch.
- **Capabilities** — `contacts:export` and `contacts:import`, both defaulting exactly as `contacts:export` did, so no role loses an ability it had.
- **One active transfer per team is a DB invariant**, not just a pre-check: the partial unique index `ContactTransferJob_teamId_active_key` (raw SQL — Prisma can't express partial uniques) makes a lost race a 409 instead of two concurrent 100k runs. The service maps the P2002 to the same friendly error.
- **This category owns its own blob lifecycle.** `contact-exports/` and `contact-imports/` are excluded from the generic blob-orphan sweeper — that sweeper deletes anything absent from `Message.mediaKey` after 24h, which would destroy a user's 7-day export while its job row still advertised a working download. There's no storage leak from the exclusion: `reapExpired` deletes job-referenced objects at `expiresAt`, and `reapAbandonedUploads` reaps staged files from abandoned wizards after 6h.

---

## Verification

Two harnesses. They are the reason to believe any of the above.

**`apps/api/scripts/contact-transfer-smoke.ts`** — 72 assertions against the real DB and real R2: Excel cell coercion, CSV/XLSX round-trip with emoji / RTL / embedded quotes+newlines / formula injection, all three write modes (including "a blank cell does not wipe"), the identity invariant (an imported email must not merge a Customer), row errors and the error report, tenant isolation. Creates and deletes a throwaway team.

```
pnpm --filter @ccp/api exec tsx scripts/contact-transfer-smoke.ts
```

**`apps/api/scripts/contact-transfer-load.ts`** — 100,000 contacts, **run under a hard heap cap**:

```
NODE_OPTIONS="--max-old-space-size=384" pnpm --filter @ccp/api exec tsx \
  scripts/contact-transfer-load.ts 100000
```

The cap IS the test. Without one, V8 lets garbage reach ~1 GB before collecting and `heapUsed` reports alarming numbers that mean nothing; under a cap, a genuinely streaming implementation still completes and a buffering one OOMs.

Measured 2026-07-21 at 100,000 contacts, `--max-old-space-size=384`:

| | wall | peak heap | output |
|---|---|---|---|
| export CSV | 10.9s | 288 MB | 10.1 MB |
| export XLSX | 9.7s | 170 MB | 7.4 MB |
| import CSV `create_only` (100k skips) | 7.0s | 170 MB | |
| import CSV upsert (100k updates) | 20.1s | 167 MB | |

384 MB is a quarter of the api container's ~1536 MB heap budget, so a transfer runs alongside the inbox rather than instead of it.

**`tests/e2e/contacts-transfer/transfer-api.spec.ts`** — 19 tests over the HTTP surface: routes mount and are capability-gated, a real multipart upload survives multer → disk → R2 → parser, the worker picks the job up and finishes it, upload-key isolation, the concurrency gate, cancel, templates, and the legacy `GET /api/contacts/export` URL still returning a CSV.

Three of those are *lifecycle invariants* whose failure mode is silent, so they're pinned rather than trusted: the blob-orphan prefix exclusion (a static assertion on the sweeper's source), a genuine concurrent-POST race against the partial unique index, and the legacy URL degrading to 503-with-Retry-After rather than a bare 409 a bookmarked link can't interpret.
