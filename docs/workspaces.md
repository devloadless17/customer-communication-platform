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

These are not assertions — they are pinned at two levels:

- `apps/api/test/workspace-management.spec.ts` (`isolation`, `team chat isolation`) proves
  that deleting a workspace takes its data and provably **not** its sibling's.
- `tests/e2e/workspace-isolation.spec.ts` (30 specs) proves it through the **real HTTP
  surface**, across every domain the restructure touched: stages, tags, contact fields,
  message flags, snippets, audience groups, contacts, conversations, messages, events,
  attachments, global search, saved views, tickets, assignment policies, workflows, the
  member roster, team chat, channel accounts, API keys and outbound webhooks.

  The second one is the load-bearing test, and the reason is worth stating: a missing
  `workspaceId` **compiles clean** (Prisma's `where` is an XOR union — see
  `scripts/check-prisma-fields.mjs`), and a suite with only one workspace can never notice.
  So the spec seeds a fully-populated SECOND workspace in the **same organization**, makes
  the test admin a full member of it, and asserts from workspace A that B's rows are absent
  from every list, unreadable by id, and unmutable by id. Same-org on purpose: a cross-org id
  is refused higher up in `resolveSession`, which would mask a missing `workspaceId` in the
  query underneath.

  It earns its keep. On its first run it caught a live defect — a controller added without
  `@UseGuards(SessionGuard)`, which 401'd for valid sessions while the caller's
  `.catch(() => [])` swallowed the failure, so the feature silently rendered nothing instead
  of erroring. Nothing else in the battery saw it.

## 2. Resolving the active workspace

Each request carries one active workspace, resolved server-side in this order:

1. the membership-validated `ccp.ws` cookie,
2. `Session.activeWorkspaceId` (the durable, per-device choice),
3. the user's first membership.

The cookie is client input, so membership is **re-validated against the database** on every
switch — a membership revoked moments ago must not stay switchable for the session-cache
window. An org owner/admin may select any workspace in their own org; a platform superAdmin
any workspace at all.

That order lives in **exactly one function** —
`resolveActiveWorkspaceId` (`packages/shared/src/auth/active-workspace.ts`) — called by all
three things that need the answer: the NestJS `SessionGuard`, the Socket.io handshake, and the
Next.js RSC `getSession`. It was three implementations once, and they drifted: the RSC copy
resolved `workspaceMemberships[0]` and never read the cookie, so after a switch the rail said
workspace B while the effective role, the capability map and the presence filter all still
described workspace A. The socket copy skipped `Session.activeWorkspaceId`, so a tab whose
cookie had been cleared joined the wrong `ws:` room. If you need the active workspace
somewhere new, call the function — don't re-derive the order.

Two consequences worth stating outright:

- **Anything workspace-scoped that gets cached is keyed by `(userId, workspaceId)`**, not by
  user. The session snapshot carries `workspaceId`, `role`, `rolePermissions` and
  `agentConversationVisibility`; keyed by user alone, one device's snapshot could serve
  another device's request in a different workspace.
- **The per-user socket room is `user:<workspaceId>:<userId>`.** The same person can be signed
  into two workspaces at once (the active workspace is per-device), and scope belongs in room
  membership rather than in a `payload.workspaceId` check every future consumer has to
  remember.

### Availability is a property of the PERSON

The availability columns live on `User` — one human, one green dot, one "back at 3pm" — but
`Workspace.workHours` (what `workHoursMode: "inherit"` inherits) is per-workspace. So exactly
ONE schedule may drive that column: the member's own grid when `mode = "custom"`, otherwise the
default of their **primary (first-joined) workspace**. `loadAvailabilityScope()` is the single
place that decides. The working-hours sweeper iterates *people*, once each — it used to loop
workspace × member, which for someone in a 09:00–17:00 workspace and a 17:00–01:00 one meant a
status flip, a socket frame and a session-cache bust every 60 seconds, landing on whichever
workspace happened to sort last.

`applyAvailability` takes `workspaceIds[]` and emits one frame per workspace, because the event
is workspace-scoped even though the fact is not.

If per-workspace availability is ever genuinely wanted ("available for Sales, away for
Support"), that is a schema change — the columns move onto `WorkspaceMember`. Don't approximate
it by letting several schedules write one column.

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

### Removing a member

`detachMemberFromWorkspace()` (`apps/api/src/lib/workspaces/remove-member.ts`) is the
counterpart to `provisionWorkspace` and exists for the same reason: what a transition *means*
gets one definition. Removal used to delete the `WorkspaceMember` row and nothing else, which
left a person who can no longer open the workspace still holding open conversations and
tickets (owned in name, absent from the Unassigned queue, so owned by nobody in practice), an
`AssignmentPolicyMember` seat, `TeamChannelMember` rows including `#general`, personal saved
views, and any policy `fixedUserId`/`fallbackUserId`/`cursorUserId` naming them.

**Deactivation runs it too, across every workspace the person belongs to** — it blocks sign-in
org-wide, so re-homing only the acting workspace's queue leaves the same problem one page
away. The two differ in one option: a removed member's threads are unassigned when no candidate
is eligible (they are never coming back), while a deactivated member's stay put (the account may
be re-enabled, and "owned by someone inactive" beats "owned by nobody" — the offline sweeper
reasons the same way).

### Who may do what

Role changes inside a workspace are a **workspace admin's** call. Deactivating an account,
deleting it, and resetting its password are **organization** actions — they reach every
workspace the person belongs to — so they gate on `canModifyUserAccount` (orgRole), not on the
workspace role. `resolveSession` collapses a platform superAdmin, an org owner/admin and a plain
org member who administers one workspace all to the effective role `"admin"`, so a workspace-role
check cannot tell them apart; before this split, a single-workspace admin could hard-delete the
organization's owner. An owner is only actionable by another owner or a platform operator.

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
