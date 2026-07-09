# Customer Identity Model

Deep-dive companion to [CLAUDE.md](../CLAUDE.md). This document describes cross-channel customer identity — **now implemented** (shipped alongside the Messenger + Instagram channels). The design below is live except for two named gaps (a persisted merge/split audit record and lifting person-level fields onto `Customer`). Read the "Current state" section for exactly what's built.

## The decision

A real business talks to the *same human* on WhatsApp, then Instagram, then email. Agents need one profile — "this is the customer, here's everything" — not three disconnected contacts. So the platform adopts a **unified customer identity**: a `Customer` (person) entity that owns many channel-scoped `Contact` rows.

This reverses the previous locked rule ("Contact = one channel identity, never merge"). It was reversed deliberately because the unified view is core to an omnichannel product and the previous rule blocked it. **But the power comes with a strict discipline to keep it simple and bug-free** — see "Rules that keep this safe" below.

## The model

```
Customer (person / unified profile)
  ├── Contact (channel identity: whatsapp)      → Conversation → Messages
  ├── Contact (channel identity: instagram)     → Conversation → Messages
  └── Contact (channel identity: email)         → Conversation → Messages
```

- **`Contact` stays the channel identity** — unchanged. It keeps `identityChannel`, `phoneNumber` / `externalContactId`, dedup constraints, and its 1:1 `Conversation`. All existing message ingest, dedup, and realtime code keeps working untouched.
- **`Conversation` stays per-contact** (one thread per channel). We do NOT merge message histories across channels — a WhatsApp thread and an Instagram thread remain separate threads. This matches the "separate threads, unified profile" model that every serious omnichannel product uses, and preserves `@@unique([teamId, contactId])`.
- **`Customer` is the new unifying layer**: shared profile fields (name, company, notes, custom fields that are person-level), and the list of linked `Contact`s. The agent UI shows the customer with a channel switcher across their threads.
- **`Contact.customerId`** (nullable FK) is the link. Null = not yet linked (every contact is its own implicit person until linked).

Stages, tags, and custom fields: decide per-field whether they live on `Contact` (channel-scoped) or `Customer` (person-scoped). Default the existing ones to stay on `Contact` and lift to `Customer` only where a person-level meaning is obvious (e.g. lifecycle stage is arguably person-level; a WhatsApp-specific opt-in flag is channel-level). Do this incrementally, not in one big move.

## Rules that keep this safe (no magic)

1. **Auto-merge ONLY on deterministic strong keys.** Two contacts auto-link into one customer only when they share a *verified exact* identifier: same normalized phone number, or same verified email. Nothing else.
2. **No fuzzy matching, ever.** No name similarity, no "probably the same person," no ML. Fuzzy matching is the single biggest source of wrong-customer data leaks — it is explicitly out of scope.
3. **Everything else is manual and reversible.** Agents can manually merge two customers or split one — implemented as `link`/`unlink` in `CustomersService`, which only re-point `Contact.customerId` (so a split fully undoes a merge). ⚠️ **Gap:** the audit-trail record (a `ConversationEvent`-style "who merged what, when") is NOT yet persisted — merge/split only writes log lines today. Add it before relying on merge history.
4. **Merge is idempotent and conservative.** Merging never deletes a `Contact` or its messages — it only re-points `Contact.customerId`. Split re-points them back.
5. **Tenant-scoped.** Identity resolution never crosses `teamId`. A phone number shared across two teams' contacts is two different customers.
6. **One writer.** Identity resolution runs in exactly one place (an `IdentityService` in the domain layer, called from the ingest pipeline after the `Contact` upsert) — never scattered across controllers or providers.

## Current state (implemented)

- **`Customer` model + `Contact.customerId`** exist (`prisma/schema.prisma`) — a person owns many channel-scoped contacts; `@@index([customerId])`.
- **Auto-merge runs** on exact phone/email via `IdentityService.resolveCustomerId` (`apps/api/src/lib/identity/identity-service.ts`), called inline on the primary inbound path and reconciled for every other create path by the drift sweeper (`apps/api/src/lib/sweepers/customer-link-drift.ts`). No fuzzy matching.
- **Manual merge/split** — `CustomersService.linkContact` / `unlinkContact` (`apps/api/src/customers/`), reversible (only re-points `customerId`; empty customers are cleaned up).
- **Agent UI** — the "Same person" panel with a per-channel thread switcher (`apps/web/src/features/inbox/components/linked-channels.tsx`), mounted in the contact panel.

## Remaining gaps (not yet built)

1. **Merge/split audit record** — see rule 3 above; only logged today.
2. **Person-level field lift** — profile fields still live on `Contact`; lifting the person-level ones onto `Customer` (one migration each) is not done.
3. **Omnichannel targeting** — nothing yet targets a `Customer` and picks the best in-window/opted-in channel; broadcasts + workflows still target individual channel-`Contact`s. This is the natural next build (see the roadmap).

## How it shipped (for reference)

Migration order actually followed: (1) `Customer` model + nullable `customerId` FK, non-destructive; (2) backfill one `Customer` per `Contact`; (3) `resolveCustomerId` in ingest + drift sweeper; (4) manual link/unlink API + the linked-channels UI. Steps for the audit record and the person-level field lift remain.
