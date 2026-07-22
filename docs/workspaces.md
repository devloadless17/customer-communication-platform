# Organization → Workspaces

> The **Organization** is a thin root: the people directory, the plan, the approval gate.
> The **Workspace** is where everything actually happens, and it is the data-isolation boundary.

```
Organization  ── plan · status · maxWorkspaces · the user directory
   └─ Workspace          ← the tenant boundary: workspaceId on every row
        ├─ Channels → accounts (several WhatsApp numbers / Pages per channel)
        ├─ Contacts → Conversations → Messages → Tickets
        ├─ Team chat (its own #general, its own messages)
        └─ Config: tags, stages, snippets, flags, teams & routing, ticket SLAs
```

A user belongs to **one organization** and joins **many of its workspaces**, holding a
**separate role in each** (`WorkspaceMember.role`: admin / manager / agent). Org-directory
standing is separate (`User.orgRole`: owner / admin / member), and platform operators are
`User.isSuperAdmin` — a flag orthogonal to every workspace, deliberately not a role value.

---

## 1. What "isolated" means, precisely

Everything except the people is per-workspace. There is no cross-workspace read anywhere:
`workspaceId` is in the `where` of every query, sourced from the session, never from client
input. There is no Prisma middleware and no RLS — the isolation is manual and load-bearing.

A new workspace therefore starts genuinely empty: **no contacts, no conversations, no channel
accounts, no tickets, no tags**, and **exactly one member** — its creator, as admin. Nobody is
auto-added; a second workspace is not "the same team again", it is a separate one you staff
deliberately.

Team chat is included in the boundary: each workspace gets its **own** `#general` (same name,
different row), messages never cross, and channel membership does not follow you.

These are not assertions — they are pinned by
`apps/api/test/workspace-management.spec.ts` (`isolation` and `team chat isolation`), which
also proves that deleting a workspace takes its data and provably **not** its sibling's.

## 2. Resolving the active workspace

Each request carries one active workspace, resolved server-side in this order:

1. the membership-validated `ccp.ws` cookie,
2. `Session.activeWorkspaceId` (the durable, per-device choice),
3. the user's first membership.

The cookie is client input, so membership is **re-validated against the database** on every
switch — a membership revoked moments ago must not stay switchable for the session-cache
window. An org owner/admin may select any workspace in their own org; a platform superAdmin
any workspace at all.

**Switching is a full page navigation, never a soft refresh.** The active workspace is the
tenant scope for every RSC query *and* the Socket.io room the client is joined to; a soft
refresh would leave the socket in the old `ws:` room, so the new workspace's inbox would render
while receiving another workspace's realtime frames.

## 3. Creating a workspace

`provisionWorkspace()` (`apps/api/src/lib/workspaces/provision.ts`) is the **single** definition
of what a new workspace contains — three lifecycle stages, the four starter message flags, a
public `#general`, and the creator as admin. Signup and the create endpoint both call it, so a
workspace created from Organization settings is byte-identical to one a signup provisions. Two
copies of that seed would drift, and the drift would only surface as "why does my second
workspace have no pipeline".

The per-organization cap is `Organization.maxWorkspaces` — super-admin controlled, **default 2**
— checked inside the transaction against a `FOR UPDATE`-locked organization row so two admins
creating at the same moment can't both slip past it.

Two guards exist because their absence is unrecoverable from the UI:

- a workspace can never be left with **zero admins** (by removal *or* demotion),
- an organization can never be left with **zero workspaces**.

Deleting a workspace cascades its contacts, conversations, messages, tickets, broadcasts and
channel accounts. There is no undo and no tombstone, so the UI requires typing the workspace
name and states exactly what is destroyed.

## 4. The three settings areas

Each is its own route with its own `SectionShell`. They must **not** nest — two shells render
two sub-sidebars and a broken content column.

| Route | Scope | Contains |
|---|---|---|
| `/organization` | the company | Account info · Admin settings (people, per-workspace access, Add user) · Workspaces |
| `/settings` | **this** workspace | People & teams · Channels & apps · Inbox · Tickets |
| `/account` | you | Profile & password · Notifications |

Personal settings live outside the workspace tree on purpose: they don't change when you switch
workspace, and burying them under workspace configuration is what sent people looking for
"change my password" in the wrong place.

## 5. Vocabulary

- **"Teams"** in the UI is `AssignmentPolicy` — a named group of members with a strategy,
  weights and capacity. It already *is* the routable group, so it is surfaced under the name
  people use rather than duplicated into a second entity that could disagree about membership.
- **Invites** target a workspace. `POST /api/invites` takes an optional `workspaceId`, validated
  server-side to belong to the caller's own organization; a workspace id from another org
  returns **404, not 403**, so it can't be used to probe for existence.

## 6. Not built yet

- Same email across two organizations (`User.email` is globally unique — a deliberate
  simplification that sidesteps a Better Auth credential-identity problem).
- Billing, org-level security policy, and org-scoped roles beyond owner/admin/member.
