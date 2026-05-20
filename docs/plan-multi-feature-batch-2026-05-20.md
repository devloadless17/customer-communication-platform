# Plan — Multi-feature batch (2026-05-20)

**Status:** awaiting user review. Do NOT start coding until explicit "go".

User requested 7 changes in one ask. Grouped here in dependency order (account avatar wiring lands first so the inbox/team-chat/assignment surfaces can reuse it).

---

## 1. User account editing + avatars everywhere

### Problem
- `User.avatarUrl` already exists on the Prisma model and is exposed by `/api/users`.
- `apps/web/src/app/(app)/settings/account/page.tsx` currently shows name/email/role as read-only dl + a password form. No way for a user to edit their own profile.
- `apps/api/src/users/users.schemas.ts` `UpdateUserSchema` only accepts `role` + `deactivated` — no `name`/`avatarUrl`.
- Outbound message bubble shows `via @senderName` text only — no avatar.
- Assignment dropdown (`apps/web/src/features/inbox/components/message-thread/assignment-dropdown.tsx`) renders initials only.
- Team-chat already renders `authorAvatarUrl` correctly — nothing to change there.

### Fix
**Backend** ([apps/api/src/users/](apps/api/src/users/)):
- New endpoint `PATCH /api/users/me` — body `{ name?, avatarUrl? }`. Session-auth only, no role check; affects the caller only.
- New endpoint `POST /api/users/me/avatar` — multipart, image-only (PNG/JPG/WEBP ≤2MB), uploads via existing UploadThing helper at [apps/api/src/lib/blob-storage/uploadthing.ts](apps/api/src/lib/blob-storage/uploadthing.ts) and writes the resulting URL back to `User.avatarUrl`. Returns `{ url }`.
- Bus event `user.profile_updated` (teamId, userId, name?, avatarUrl?) → realtime fanout to the team so inbox + assignment dropdowns + active conversation panels update without a refresh.
- `UpdateUserSchema` (admin-only existing route) stays untouched. Self-edit is a separate schema on the new `/me` route.

**Frontend**:
- [apps/web/src/app/(app)/settings/account/page.tsx](apps/web/src/app/(app)/settings/account/page.tsx) — convert to RSC shell + new `<AccountProfileForm>` client component. Avatar picker (click-to-upload, drag-drop, "remove" action), name field, "Save" submits to `/api/users/me`. Password form stays.
- [apps/web/src/features/inbox/components/message-bubble.tsx](apps/web/src/features/inbox/components/message-bubble.tsx) — accept `senderAvatarUrl?`; for outbound bubbles, render a 20×20 avatar to the left of/above the name (need a quick mock — see "Open decision A" below).
- [apps/web/src/features/inbox/components/message-thread/assignment-dropdown.tsx](apps/web/src/features/inbox/components/message-thread/assignment-dropdown.tsx) — wrap initials in `<AvatarImage src={u.avatarUrl} />` with initials fallback.
- Conversation header where the assigned agent is shown (already shows name) — same avatar treatment.
- Wire the new `user.profile_updated` socket event into the team-members cache so changes propagate live.

**Risks**
- Currently `senderUserId` joins to `User.name` on the messages query — confirm the existing query also selects `avatarUrl` and threads it through to the bubble. If not, that's the lift on the read path.
- UploadThing token is shared across teams (already-known scaling cliff per CLAUDE.md). Avatar URLs are public-readable; acceptable for pilot scope.

**Files touched (est. 7-9):** 2 backend (controller + service), 1 schema, 1 RSC page rewrite, 1 new client form, 2-3 inbox components, 1 socket-event subscriber.

**Open decision A — outbound bubble avatar placement:**
Two layout candidates, pick one before I implement:

  Option 1 — avatar above the bubble (chat-app style):
    ```
                       [👤 Sarah]
                       ┌─────────────────┐
                       │ Hey, just sent  │
                       │ over the file.  │
                       └─────────────────┘
                                    2:14p ✓✓
    ```

  Option 2 — avatar inline-left of the bubble (Slack/Front style):
    ```
                  👤   Sarah · 2:14p
                       ┌─────────────────┐
                       │ Hey, just sent  │
                       │ over the file.  │
                       └─────────────────┘
                                       ✓✓
    ```

I'd default to Option 2 (denser, matches assignment-pane density). Confirm or switch.

---

## 2. Team-chat per-channel member management

### Problem
Today every team member is implicitly in every channel ([prisma/schema.prisma:1492-1493](prisma/schema.prisma) comment confirms). No `TeamChannelMember` table exists.

### Fix
**Schema**:
```prisma
model TeamChannelMember {
  channelId String
  userId    String
  addedAt   DateTime @default(now())
  addedById String?

  channel TeamChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user    User        @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([channelId, userId])
  @@index([userId])
}
```
Plus `members TeamChannelMember[]` back-relation on `TeamChannel` and `channelMemberships TeamChannelMember[]` on `User`.

**Migration**: backfill — for every existing `TeamChannel`, insert a row for every team member. Zero behavior change on day one (everyone still sees every channel they could see before).

**Backend** ([apps/api/src/team-chat/channels.controller.ts](apps/api/src/team-chat/channels.controller.ts) + service):
- `GET    /api/team/channels/:id/members` — list members (id, name, email, avatarUrl, role, addedAt).
- `POST   /api/team/channels/:id/members` — body `{ userIds: string[] }`, admin/manager only.
- `DELETE /api/team/channels/:id/members/:userId` — admin/manager only; default channel disallows removal of anyone (the "general" channel stays everyone-included by rule).
- `listChannelsForUser` becomes a join through `TeamChannelMember` so users only see channels they're members of.
- On `User` create (team invite accept) — auto-add to the team's default channel (and any channel where the team admin has set "auto-add new members" — defer this flag unless you want it now; default behavior: only auto-join the default channel).
- Bus events: `team_channel.member_added` / `team_channel.member_removed` → socket fanout `team:channel:member:added` / `:removed` to the team. Also publish a `team.catalog_changed` (scope `"team-channels"`) so the existing channel-list reducer picks up access-grant/revoke without a separate handler.

**Frontend** ([apps/web/src/features/team-chat/](apps/web/src/features/team-chat/)):
- `channel-header.tsx` — the existing `memberCount` prop becomes real and turns into a clickable "N members" button.
- New `channel-members-dialog.tsx` — list current members with remove-X buttons, an "Add people" combobox at the top (team-member picker, multi-select).
- `channel-dialogs.tsx` create-flow — extend with a "Who's in this channel?" step. Default: creator only. Provide "Add everyone in the team" as a one-click option.
- `use-team-channels-events.ts` — subscribe to `team:channel:member:added` / `:removed`; on a removal event where `userId === currentUser.id`, remove the channel from the visible list AND if it's the active channel, redirect to the default channel.

**Risks**
- Backfilling existing channels is straightforward; needs a manual `pnpm db:migrate` run on deploy. Migration script keeps it idempotent with `ON CONFLICT DO NOTHING`.
- Default channel must stay everyone-in. Service layer enforces it; clients shouldn't be able to remove anyone from it via API.
- Mention parsing today only resolves @user — that still works regardless of membership, but I'll add a "this user isn't in this channel" indicator at the autocomplete level (no hard block — Slack lets you @ anyone too).

**Files touched (est. 8-10):** 1 prisma migration, 1 controller, 1 service, 1 permissions helper (`@ccp/shared/team-chat/permissions`), 1 new fanout rule, 2 new dialogs, 1 header tweak, 1 socket subscriber.

---

## 3. Custom-field name collision (don't shadow built-ins)

### Problem
[apps/api/src/team/contact-fields/contact-fields.service.ts:113](apps/api/src/team/contact-fields/contact-fields.service.ts#L113) `create()` checks for collisions among existing custom field keys but NOT against built-in `Contact` columns. A user can create a custom field named "location" or "email" and shadow the built-in (which is what surfaced this — the user added `location` and saw it conflict with the built-in `location` column).

### Fix
- Add a `RESERVED_FIELD_KEYS` constant in `@ccp/shared/contacts/` exporting the slugified built-in column names: `phone_number`, `phone`, `name`, `full_name`, `email`, `location`, `first_name`, `last_name`, `language`, `country_code`, `tags`, `stage`, `id`, `source`, `created_at`, `last_inbound_at`, `last_outbound_at`. (Reuses the same list as CSV import header recognition, so we keep one source of truth.)
- In `ContactFieldsService.create()` AND `.update()`, reject when slugified label ∈ RESERVED. Return 400 with a clear message: `"\"Location\" is a built-in contact field — pick a different name."`
- Mirror the validation in the Zod schema so the same error surfaces in the frontend without an API round-trip.

**Files touched (est. 3):** 1 shared constant, 1 service, 1 schema.

**Open decision B — what to do about existing custom fields that already shadow built-ins (i.e., the user's current "location" custom field):**

Three options:

  Option 1 — Leave existing rows alone; only block new creations. Conservative.
  Option 2 — Migration that detects shadow fields and auto-renames them with a `_custom` suffix (`location` → `location_custom`). Cleaner long-term, riskier.
  Option 3 — Detect on first load post-deploy and surface a one-time toast: "You have a custom field 'location' that shadows a built-in. Rename or delete?"

I'd default to Option 1 + a one-shot warning in the contact-fields settings page banner. Confirm.

---

## 4. Contact import CSV template (downloadable)

### Problem
[apps/web/src/app/(app)/contacts/import-dialog.tsx](apps/web/src/app/(app)/contacts/import-dialog.tsx) tells the user which column headers it accepts via prose, but there's no way to download a template file. New users guess at the format and fail the import.

### Fix
- New endpoint `GET /api/contacts/template.csv` — returns a CSV with only headers (no data rows). Headers = built-in fields + every active `ContactFieldDefinition` for the team. First row pre-populated with placeholder example values? Better not — empty so people don't accidentally import "John Doe" as a real contact. Just header row.
- Header order: `phone_number,name,email,location,first_name,last_name,language,country_code,<custom_field_label_1>,<custom_field_label_2>,...,tags,stage`.
- Frontend: add a "Download template" link in [apps/web/src/app/(app)/contacts/import-dialog.tsx](apps/web/src/app/(app)/contacts/import-dialog.tsx) above the file picker, with a one-liner: "These are the columns the importer recognizes. Custom fields and tags are optional."
- Also surface the reserved/built-in list in the contact-fields settings page so admins don't try to create a field that collides (ties into #3).

**Files touched (est. 3):** 1 controller method, 1 service method, 1 import dialog tweak.

---

## 5. Broadcast "All contacts" recipient count shows 0

### Root cause (confirmed)
[apps/api/src/lib/queries/audience-groups.ts:177](apps/api/src/lib/queries/audience-groups.ts#L177):

```typescript
export async function countAudienceContacts(
  teamId: string,
  { tagIds = [], contactIds = [] }: { tagIds?: string[]; contactIds?: string[] },
): Promise<number> {
  const tags = tagIds.filter((s) => s.length > 0);
  const ids = contactIds.filter((s) => s.length > 0);
  if (tags.length === 0 && ids.length === 0) return 0;  // ← bug
  ...
}
```

The new-broadcast page calls `countContacts({})` to seed `totalContactCount` for the "All contacts" card. Empty input hits the early-return. Note: the *send-time* path is fine — `broadcasts.service.ts:150-156` does a `contact.findMany({ where: { teamId } })` separately. So the bug is purely cosmetic in the wizard, but breaks UX because users see "Broadcast to 0 contacts" and abandon.

### Fix
Two options, picking the simpler one:

- **Simpler (this one):** Change `countContacts({})` semantics on the frontend. The new-broadcast page already knows it wants "total team contacts" — call a dedicated `GET /api/contacts/count` (no body) that returns `Contact.count({ where: { teamId } })`. Then keep `countAudienceContacts` strict about its current contract (empty = 0).
- More invasive: add a `mode: 'all'` param to `countAudienceContacts`. Rejected — it makes the function do two unrelated things.

**Files touched (est. 3):** 1 new GET endpoint + service method, 1 frontend query helper, 1 line in [apps/web/src/app/(app)/broadcasts/new/page.tsx](apps/web/src/app/(app)/broadcasts/new/page.tsx).

---

## 6. Stage colors render as white / washed out

### Diagnosis
Stages already have a `color` field (default `"slate"`) and use the same `TAG_COLORS` palette as tags. The picker UI ([stages-settings.tsx](apps/web/src/app/(app)/settings/stages/stages-settings.tsx) line 484) lets users pick a color. So the schema is fine.

The user-visible "all white" is one of two issues:

1. **Stages created before the color column had a usable default** — likely existing stage rows have empty/whitespace color values, and `tagColorClasses(color)` falls back to `slate.solid = bg-slate-500` but the `chip` variant `bg-slate-500/10` (10% opacity on a white card background) reads as near-white.
2. **The chip variant is genuinely too pale for stage badges**, which are larger and lower-density than tag chips, so they need more saturation.

### Fix
- **Audit existing rows**: SQL `UPDATE "ContactStage" SET color = 'slate' WHERE color IS NULL OR color = '';` ship as a one-time migration.
- **Beef up the chip palette for stages specifically**: introduce a `tagColorClasses().pill` variant that's higher contrast than `chip` — e.g., `bg-slate-500/25 text-slate-900 border-slate-500/50 dark:text-slate-100`. Use this in the stage-display sites (contact-browser stage column, conversation detail-panel stage pill, stage dropdown labels). Tag chips continue to use the lighter `chip` variant.
- **Default new-stage color**: round-robin through the palette instead of everyone defaulting to slate so each new stage feels distinct. Service-side: pick the first color not yet used by another stage in the team; if all 9 are taken, fall back to slate.
- Verify the dot (`solid`) variant already renders correctly — it should since it's `bg-{color}-500`. The "all white" complaint is almost certainly about the chip/pill background, not the dot.

**Files touched (est. 4):** 1 migration, 1 shared color helper extension, 1 service (default-color picker), 2-3 frontend rendering sites switching `chip` → `pill`.

**Need from you:** can you confirm "all white" means the chip background looks washed out (Diagnosis #2) vs. the dot itself being white (Diagnosis #1 — would mean DB rows have invalid color)? A quick screenshot or "yes the background is pale" answer pins this. If you can't, I'll do both fixes — they don't conflict.

---

## 7. Voice recording errors / fails to send

### Root cause (confirmed)
[apps/web/src/features/inbox/components/reply-box/voice-recorder.tsx:31-35](apps/web/src/features/inbox/components/reply-box/voice-recorder.tsx#L31-L35):

```typescript
const MIME_CANDIDATES = [
  "audio/ogg;codecs=opus",   // Meta accepts ✓
  "audio/mp4",               // Meta accepts ✓
  "audio/webm;codecs=opus",  // Meta REJECTS ✗
] as const;
```

When Chrome (most users) lands on `audio/webm`, Meta's `sendMedia` rejects it after upload — the user sees a failed send with no clear reason. The existing comment even flags this ("if we land here Meta may transcode or may reject") but no transcode happens in our pipeline.

### Fix
Two layers:

- **Frontend** — drop webm from candidates. On browsers without ogg/opus support, surface a clear error toast: "Your browser doesn't support recording in a WhatsApp-compatible format. Please use a recent Chrome, Firefox, or Safari." (Chrome ≥105 supports ogg/opus; Safari does mp4; Firefox does ogg/opus. So we should have ≥98% browser coverage.)
- **Backend** — defense-in-depth: in `MessagesService.sendMedia`, validate audio mimetype against an allowlist (`audio/ogg`, `audio/mp4`, `audio/mpeg`, `audio/aac`, `audio/amr`) before hitting Meta. Reject with 415 + clear error if it doesn't match. Today the request hits Meta and bubbles a generic "provider_rejected" — not actionable.
- **Optional polish**: send the audio as a `voice` message (WhatsApp will render the waveform UI on the recipient's side) instead of a generic audio attachment. Meta's API supports `voice: true` on the audio payload. Worth doing in the same patch — it's a 1-line change in [apps/api/src/lib/providers/meta.ts](apps/api/src/lib/providers/meta.ts) and dramatically improves the recipient UX (looks like a real WhatsApp voice note, not a "file attached").

**Files touched (est. 3-4):** voice-recorder.tsx, MessagesService (mime allowlist), meta.ts provider (voice flag).

---

## Cross-cutting concerns

### Migration ordering
Two new Prisma migrations needed (channel members table + the stage color backfill). Both are additive/idempotent — safe on deploy. Run order doesn't matter.

### Realtime cache patches
Two new socket events introduced:
- `team:channel:member:added` / `:removed` — wire into [apps/web/src/features/team-chat/contexts/team-chat-data.tsx](apps/web/src/features/team-chat/contexts/team-chat-data.tsx).
- `user:profile_updated` — wire into the team-members cache used by the assignment dropdown + the message-bubble's senderName lookup.

Per the realtime cache-patch matrix rule in CLAUDE.md, both reducers AND the inbox-shell reducer needs the new event added. I'll check before writing.

### Optimistic dispatch
- Avatar upload: dispatch local `user:profile_updated` immediately so the form shows the new avatar before server fanout (matches the optimistic-socket-dispatch feedback rule).
- Adding channel members: dispatch local `team:channel:member:added` for each added id so the dialog reflects the change instantly.

### Auth/permissions
- `/api/users/me` and `/api/users/me/avatar` — session-auth, no role check.
- Channel member endpoints — admin/manager only (matches `canManageChannel` rule).
- Custom field collision — applies to anyone who can create a field (already admin-only via existing controller).

### What I'm NOT doing in this batch (to keep scope tight)
- Private vs public channels (different from membership — that's a separate feature). Only explicit membership lists; if you're in the list you can see + write, otherwise no.
- Per-team UploadThing isolation (avatar URLs land in the shared bucket — known scaling cliff).
- Editing email or role on the self-profile (email change has verification flow implications, role can't be self-edited by design).
- Replacing the entire color palette globally — extending the existing one with a higher-contrast `pill` variant only.

---

## Order of work (after you approve)

1. Migrations (channel members + stage color backfill) — both additive, safe.
2. Backend endpoints (users/me, channel members, contacts/count, contacts/template, contact-fields collision check, message audio mime guard).
3. Shared types + DTOs + socket-event schemas.
4. Voice recorder frontend fix (smallest piece, ship-quality immediately).
5. Account settings page rebuild.
6. Inbox message-bubble + assignment-dropdown avatar wiring.
7. Channel members dialog + create-flow update.
8. Broadcast "all" count wiring.
9. Stage chip palette + default-color round-robin.
10. CSV template button.
11. Run typecheck (both projects) + smoke-boot both servers per the smoke-boot rule.

Estimated touch: ~25-30 files, all surgical.

---

## Open decisions waiting on you

- **A** — outbound message bubble avatar placement (Option 1 above-bubble vs Option 2 inline-left).
- **B** — existing shadow custom fields like the user's current "location": leave alone with banner, auto-rename, or block on next edit.
- **Stages "all white"** confirmation — chip background washed out vs. dot literally white. (If unclear, I'll do both fixes.)
- Anything in this list you want dropped or reordered before I start.

Once you respond, I'll move to implementation.
