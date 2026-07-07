# Customer Identity Model (adopted target)

Deep-dive companion to [CLAUDE.md](../CLAUDE.md). This document describes the **adopted target** for cross-channel customer identity. It is a design decision, not yet implemented — the current schema is `Contact`-only (per-channel). Read the "Current state" and "Migration" sections before writing any code against it.

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
3. **Everything else is manual and reversible.** Agents can manually merge two customers or split one, always with an audit trail (`ConversationEvent`-style record of who merged what and when). A merge must be undoable.
4. **Merge is idempotent and conservative.** Merging never deletes a `Contact` or its messages — it only re-points `Contact.customerId`. Split re-points them back.
5. **Tenant-scoped.** Identity resolution never crosses `teamId`. A phone number shared across two teams' contacts is two different customers.
6. **One writer.** Identity resolution runs in exactly one place (an `IdentityService` in the domain layer, called from the ingest pipeline after the `Contact` upsert) — never scattered across controllers or providers.

## Current state

- Only `Contact` exists (`prisma/schema.prisma`), channel-scoped, no `Customer` table, no `customerId`. Auto-merge does not run.
- The app behaves as "one contact = one person" today, which is correct for the single live channel (WhatsApp).

## Migration (when a second channel ships and unification is needed)

1. Add `model Customer` (teamId, profile fields, timestamps) and `Contact.customerId Int?` FK + index. Non-destructive.
2. Backfill: create one `Customer` per existing `Contact` and link 1:1. Every contact keeps behaving exactly as before.
3. Introduce `IdentityService.resolveAndLink(contact)` in the ingest pipeline: on a new/updated contact, look up other contacts in the team sharing a verified phone/email; if found, link to the same `Customer`; else keep its own.
4. Add manual merge/split endpoints + audit records + the agent UI (customer profile with channel switcher).
5. Lift person-level fields from `Contact` to `Customer` one field at a time, each behind its own migration.

Until step 1 ships, treat "contact" and "customer" as the same thing in code. Do not build speculative `Customer` plumbing before a second channel makes it real — see the anti-overengineering rule in [CLAUDE.md](../CLAUDE.md).
