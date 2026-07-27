import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { generateInviteToken, hashInviteToken, inviteExpiry } from "@/auth/invite-token";
import { hashPassword } from "@/auth/password";
import { assignableRoles, type UserActor } from "@ccp/shared/auth/permissions";
import { validatePasswordStructure } from "@ccp/shared/auth/password-policy";
import { sendMail } from "@ccp/shared/mail/send";
import { inviteEmail } from "@ccp/shared/mail/templates";
import type { Role } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import type { ApiSession } from "../auth/session.guard";
import { DbService } from "../db/db.service";
import type { AcceptInviteInput, CreateInviteInput } from "./invites.schemas";
import { joinDefaultChannel } from "@/lib/team-chat/default-channel";

/** See create(): the re-invite path deletes the pending row before counting
 *  seats, so the seat cap cannot bound resends. This does. */
const INVITE_RESEND_COOLDOWN_MS = 60_000;

export interface InviteListDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  createdByName: string;
}

export interface InviteCreateDto {
  id: string;
  expiresAt: string;
  url: string;
  /**
   * Did the invite email actually go out?
   *
   * Returned so the UI can say "we couldn't email it — send them this link"
   * rather than implying a delivery that never happened. The `url` is always
   * present precisely so a mail failure is recoverable by hand.
   */
  emailed: boolean;
}

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /** List PENDING (un-accepted, un-expired) invites for the team. */
  /**
   * Which workspace an invite is being written into.
   *
   * Defaults to the caller's active workspace. A caller may name a DIFFERENT
   * one only when it belongs to their own organization — otherwise a crafted id
   * would let an admin of org A mint a working invite into org B.
   *
   * Role gate: `@RequireRole("admin")` on the controller only proves the caller
   * administers their ACTIVE workspace — it passes for a plain member
   * (`orgRole: member`) who holds `WorkspaceMember.role = admin` in ONE
   * workspace. Such a caller is NOT entitled to staff a sibling workspace they
   * don't administer, so targeting a different workspace requires either being
   * an org manager (owner/admin/superAdmin — admin everywhere in the org) or
   * being an admin member of the TARGET itself. Without this, a single-workspace
   * admin could mint an admin invite into any sibling workspace in the org.
   */
  async resolveTargetWorkspace(
    session: Pick<
      ApiSession,
      "workspaceId" | "organizationId" | "orgRole" | "isSuperAdmin" | "userId"
    >,
    requested: string | undefined,
  ): Promise<string> {
    if (!requested || requested === session.workspaceId) return session.workspaceId;

    const inOrg = await this.db.workspace.count({
      where: { id: requested, organizationId: session.organizationId },
    });
    // 404, not 403 — a 403 would confirm the workspace exists to someone
    // outside the org that owns it.
    if (!inOrg) throw new NotFoundException({ error: "workspace_not_found" });

    const isOrgManager =
      session.isSuperAdmin ||
      session.orgRole === "owner" ||
      session.orgRole === "admin";
    if (!isOrgManager) {
      // Plain workspace admin — must actually administer the TARGET. This is a
      // sibling workspace in their own org, so a 403 (it exists, you can't
      // staff it) is correct; the existence isn't a secret from an org member.
      const adminHere = await this.db.workspaceMember.count({
        where: { userId: session.userId, workspaceId: requested, role: "admin" },
      });
      if (!adminHere) throw new ForbiddenException({ error: "workspace_forbidden" });
    }
    return requested;
  }

  async list(workspaceId: string): Promise<InviteListDto[]> {
    const rows = await this.db.invite.findMany({
      where: {
        workspaceId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        createdBy: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role as Role,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdBy?.name ?? "Removed user",
    }));
  }

  async create(
    workspaceId: string,
    inviter: UserActor,
    inviterUserId: string,
    originUrl: string,
    input: CreateInviteInput,
  ): Promise<InviteCreateDto> {
    const allowed = assignableRoles(inviter);
    const requestedRole =
      input.role && (allowed as string[]).includes(input.role)
        ? (input.role as Role)
        : null;
    const role: Role = requestedRole ?? "agent";
    if (!allowed.includes(role)) {
      throw new ForbiddenException({ error: "role_not_assignable_by_you" });
    }

    // Loaded once, up front: the org id gates the message below, `maxMembers`
    // gates the seat pre-check, and `name` rides along for the invite EMAIL —
    // "you've been invited to Acme Support" is the difference between a message
    // someone trusts and one that reads like phishing.
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true, maxMembers: true, name: true },
    });
    if (!workspace) throw new NotFoundException({ error: "workspace_not_found" });

    // User.email is globally unique — friendly error before we create an
    // invite that could never be accepted anyway (accept always does
    // `user.create`, so an existing account can never redeem one).
    const existingUser = await this.db.user.findUnique({
      where: { email: input.email },
      select: { id: true, organizationId: true, name: true },
    });
    if (existingUser) {
      // Someone already in THIS organisation is the common, legitimate case in
      // a multi-workspace product: an admin staffing a second workspace types a
      // colleague's address. A bare "email already in use" reads as "that
      // address belongs to a stranger" and dead-ends them, when the action they
      // want is one page away. Name it, and point at it.
      if (existingUser.organizationId === workspace.organizationId) {
        throw new ConflictException({
          error: "already_in_organization",
          detail: `${existingUser.name} is already in your organization. Add them to this workspace from Organization → Members instead of inviting them.`,
        });
      }
      // A user of ANOTHER organisation. Deliberately kept generic: naming them
      // would let any workspace admin probe whether an arbitrary address has an
      // account on the platform, and who it belongs to.
      throw new ConflictException({ error: "email_already_in_use" });
    }

    // Per-recipient cooldown BEFORE the wipe below. Re-invite deletes the prior
    // pending row and then counts seats, so `activeMembers + pendingInvites`
    // stays flat no matter how many times you loop — the seat cap could never
    // stop it, and every iteration sent a REAL email from the platform's shared
    // sender identity. That made this route a mail bomb aimed at any address an
    // admin cares to type, burning deliverability for every other tenant.
    const recent = await this.db.invite.findFirst({
      where: {
        workspaceId,
        email: input.email,
        acceptedAt: null,
        createdAt: { gt: new Date(Date.now() - INVITE_RESEND_COOLDOWN_MS) },
      },
      select: { createdAt: true },
    });
    if (recent) {
      throw new ConflictException({
        error: "invite_recently_sent",
        detail: `An invite was already sent to this address moments ago. Wait a minute before sending another, or copy the existing link from the list.`,
      });
    }

    // Wipe prior pending invites for this (team, email) so the new link
    // is the only valid one (re-invite UX). Opportunistically drop EXPIRED
    // invites for this team in the same query — keeps the table clean
    // without a cron.
    await this.db.invite.deleteMany({
      where: {
        workspaceId,
        acceptedAt: null,
        OR: [{ email: input.email }, { expiresAt: { lt: new Date() } }],
      },
    });

    // Member-cap pre-check (soft UX gate — invite-accept is the authoritative
    // race-safe enforcement). Each still-pending invite reserves a future seat,
    // so `active members + pending invites` must stay under the cap or an
    // accepted invite would exceed it. Counted AFTER the cleanup above, so a
    // re-invite to the same email (whose prior pending row was just deleted)
    // doesn't double-count its own slot. Active members only — deactivated
    // accounts don't hold a seat.
    // The seat cap is PER-WORKSPACE. After the workspaces restructure a member
    // belongs to a workspace (a WorkspaceMember row), not to the organisation
    // as a whole — the same person can hold seats in two workspaces and that is
    // the intended model. The organisation instead caps how many WORKSPACES it
    // may create (`Organization.maxWorkspaces`), which is what bounds the total.
    const [activeMembers, pendingInvites] = await Promise.all([
      // superAdmins are platform operators, not seats — never counted. In
      // production a customer workspace has none; this only matters where
      // tooling co-locates an operator into one.
      this.db.workspaceMember.count({
        where: {
          workspaceId,
          user: { deactivatedAt: null, isSuperAdmin: false },
        },
      }),
      this.db.invite.count({
        where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    const maxMembers = workspace.maxMembers;
    if (maxMembers !== undefined && activeMembers + pendingInvites >= maxMembers) {
      throw new ConflictException({
        error: "member_limit_reached",
        detail: `This workspace is at its member limit (${maxMembers} member${maxMembers === 1 ? "" : "s"}). Ask your platform administrator to raise the limit before inviting more.`,
      });
    }

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);
    const invite = await this.db.invite.create({
      data: {
        workspaceId,
        email: input.email,
        role,
        tokenHash,
        createdById: inviterUserId,
        expiresAt: inviteExpiry(),
      },
      select: { id: true, expiresAt: true },
    });

    // Build share URL from BETTER_AUTH_URL when set; else the request's
    // own origin. Behind a proxy, req.url can resolve to 0.0.0.0:NNN which
    // produces unusable invite links — env-driven origin is the safe path.
    const origin = process.env.BETTER_AUTH_URL || originUrl;
    const url = `${origin.replace(/\/$/, "")}/invite/${token}`;

    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "invites" });

    // SEND it. Until now this endpoint only ever RETURNED a link and left the
    // admin to forward it by hand — which is why "invite a teammate" was a
    // multi-step chore involving another app.
    //
    // Best-effort on purpose, and this is the one place a swallowed mail error
    // is right: the invite ROW is already committed and the URL is returned
    // below, so an admin whose mail fails can still copy the link. Throwing
    // here would roll the useful part of the work into an error.
    let emailed = true;
    try {
      const { subject, html, text } = inviteEmail({
        url,
        workspaceName: workspace?.name ?? "your workspace",
        // UserActor carries no display name, and re-reading the inviter here
        // would add a query to every invite for one line of copy. "You've been
        // invited to <workspace>" is the part that matters.
        inviterName: null,
      });
      await sendMail({ to: input.email, subject, html, text });
    } catch (err) {
      emailed = false;
      this.logger.error(
        `invite email failed for ${input.email}: ${err instanceof Error ? err.message : err}`,
      );
    }

    // `emailed` is returned so the UI can say "we couldn't email it — send them
    // this link" instead of implying delivery that never happened.
    return { id: invite.id, expiresAt: invite.expiresAt.toISOString(), url, emailed };
  }

  /**
   * Revoke a PENDING invite by hard-deleting the row. Already-accepted
   * invites are historical audit rows; admins remove the resulting User
   * via /api/users/[id] instead. Scope by workspaceId so a foreign id can never
   * match and an already-accepted invite is treated as "not found".
   */
  async revoke(workspaceId: string, id: string): Promise<void> {
    const result = await this.db.invite.deleteMany({
      where: { id, workspaceId, acceptedAt: null },
    });
    if (result.count === 0) throw new NotFoundException({ error: "invite_not_found" });
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "invites" });
  }

  /**
   * Read-only invite lookup for the landing page. Returns the invite shape
   * the page needs to render (email + role + team name) or a status code
   * indicating why this isn't usable. Never exposes tokenHash and doesn't
   * mutate the row — accept() is the only place that does.
   */
  async lookup(token: string): Promise<{
    status: "valid" | "invalid" | "used" | "expired";
    invite: { email: string; role: Role; teamName: string } | null;
  }> {
    const tokenHash = hashInviteToken(token);
    const invite = await this.db.invite.findUnique({
      where: { tokenHash },
      select: {
        email: true,
        role: true,
        acceptedAt: true,
        expiresAt: true,
        workspace: { select: { name: true } },
      },
    });
    if (!invite) return { status: "invalid", invite: null };
    if (invite.acceptedAt) {
      return {
        status: "used",
        invite: {
          email: invite.email,
          role: invite.role as Role,
          teamName: invite.workspace?.name ?? "your team",
        },
      };
    }
    if (invite.expiresAt < new Date()) {
      return {
        status: "expired",
        invite: {
          email: invite.email,
          role: invite.role as Role,
          teamName: invite.workspace?.name ?? "your team",
        },
      };
    }
    return {
      status: "valid",
      invite: {
        email: invite.email,
        role: invite.role as Role,
        teamName: invite.workspace?.name ?? "your team",
      },
    };
  }

  /**
   * Accept an invite: validate the token + password, create the User +
   * Better-Auth `Account` row + stamp `acceptedAt` in one transaction,
   * publish catalog events. Returns the email + workspaceId so the (web-side)
   * caller can complete sign-in via Better Auth and set the cookie.
   *
   * Why this lives in NestJS (not the original Next.js server action):
   * post-Phase-5 the bus runs in-process — a web-side publish() would never
   * reach the realtime-fanout / audit / cache-revalidate subscribers in
   * NestJS. Doing the credential write here keeps the side-effect graph
   * coherent. Password hashing uses bcrypt at cost 10 to match Better Auth's
   * configured hasher (see apps/web/src/lib/auth/better-auth.ts) — keep them
   * in lock-step so credentials created here verify on signin.
   */
  async accept(
    input: AcceptInviteInput,
  ): Promise<{ email: string; workspaceId: string }> {
    // Server-side password policy: the web action runs validatePasswordStructure
    // in @ccp/shared, but a direct POST to /api/invites/accept bypasses the form.
    // Without this gate any string ≥ 6 chars would be accepted, even though
    // policy may tighten over time (NIST/OWASP floor is currently above the
    // schema's min(6)). Re-validate here as second-line defense.
    const policyError = validatePasswordStructure(input.password);
    if (policyError) {
      throw new BadRequestException({ error: "weak_password", detail: policyError });
    }
    const tokenHash = hashInviteToken(input.token);
    const passwordHash = await hashPassword(input.password);

    let result: { email: string; workspaceId: string };
    try {
      result = await this.db.$transaction(async (tx) => {
        const invite = await tx.invite.findUnique({ where: { tokenHash } });
        if (!invite) throw new InviteAcceptError("invite_invalid", "This invite link is invalid.");
        if (invite.acceptedAt) {
          throw new InviteAcceptError("invite_used", "This invite has already been used.");
        }
        if (invite.expiresAt < new Date()) {
          throw new InviteAcceptError(
            "invite_expired",
            "This invite has expired. Ask your admin for a new link.",
          );
        }

        // Race: someone may have registered with this email between the
        // invite create and now. User.email is globally unique — the
        // constraint is the final guard; we surface a friendly message.
        const existing = await tx.user.findUnique({ where: { email: invite.email } });
        if (existing) {
          throw new InviteAcceptError(
            "email_taken",
            "An account with this email already exists. Sign in instead.",
          );
        }

        // Member-cap enforcement (authoritative). `FOR UPDATE` locks the team
        // row for this transaction so two invites accepted in the same instant
        // can't both read "1 of 2" and both insert → 3. The lock serializes
        // them; the second waits, re-reads the now-current count, and is
        // rejected. Active members only — deactivated accounts free their seat.
        // The seat cap is PER-WORKSPACE, so the row we lock is the WORKSPACE.
        // `FOR UPDATE` is load-bearing, not decorative: two people accepting
        // the last seat at the same instant would both read count < max and
        // both insert, putting the workspace one over its cap permanently.
        // Serialising on the workspace row makes the loser re-read after the
        // winner commits and correctly see the workspace full.
        const lockedWs = await tx.$queryRaw<
          { maxMembers: number; organizationId: string }[]
        >`
          SELECT "maxMembers", "organizationId" FROM "Workspace"
          WHERE id = ${invite.workspaceId} FOR UPDATE
        `;
        const maxMembers = lockedWs[0]?.maxMembers ?? 2;
        // Same locked row supplies the org the new user belongs to — no second
        // lookup, and it cannot disagree with what we just locked.
        const organizationId = lockedWs[0]?.organizationId;
        if (!organizationId) {
          throw new InviteAcceptError("invalid", "This invite is no longer valid.");
        }
        // The invited org must still be ACTIVE. An invite minted before a
        // suspension kept working: it created a User + credential Account into
        // a suspended (or still-pending) org, burned a seat, and handed the
        // person a session that every downstream gate then refuses — a
        // confusing dead end, and a way to grow a suspended tenant's
        // directory. Read inside the same transaction that holds the
        // workspace lock, so a suspension racing an accept can't slip through.
        const org = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { status: true },
        });
        if (org?.status !== "active") {
          throw new InviteAcceptError(
            "invalid",
            org?.status === "pending"
              ? "This organization is still awaiting approval. Ask whoever invited you to try again once it's approved."
              : "This organization isn't active. Contact whoever invited you.",
          );
        }
        const memberCount = await tx.workspaceMember.count({
          where: {
            workspaceId: invite.workspaceId,
            user: { deactivatedAt: null, isSuperAdmin: false },
          },
        });
        if (memberCount >= maxMembers) {
          throw new InviteAcceptError(
            "team_full",
            `This workspace has reached its member limit (${maxMembers} member${maxMembers === 1 ? "" : "s"}). Ask the organization's admin to request a higher limit.`,
          );
        }

        // The user belongs to the ORG; the invited ROLE is a per-workspace
        // grant, so it lands on a WorkspaceMember row rather than the user.
        const user = await tx.user.create({
          data: {
            organizationId,
            name: input.name,
            email: invite.email,
            // VERIFIED without an OTP, and this is load-bearing rather than a
            // shortcut: the invite link was emailed to THIS address and they
            // are holding the token from it, which is the same proof a code
            // would give. `emailVerified` now defaults to FALSE, so without
            // this line every invited teammate lands on /verify waiting for a
            // code nobody sent — the invite flow would be dead on arrival.
            emailVerified: true,
          },
        });
        await tx.workspaceMember.create({
          data: {
            userId: user.id,
            workspaceId: invite.workspaceId,
            role: invite.role,
          },
        });
        // Better Auth verifies credentials against the `Account` row, not
        // the User. Same transaction so a failed account insert rolls back
        // the user create.
        await tx.account.create({
          data: {
            userId: user.id,
            providerId: "credential",
            accountId: invite.email,
            password: passwordHash,
          },
        });
        await tx.invite.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date() },
        });

        // Auto-join the default channel so the new teammate sees #general the
        // moment they log in. Non-default channels stay invite-by-admin; the
        // members dialog (apps/web/src/features/team-chat/channel-members-*)
        // is where the admin adds them to specialized rooms.
        await joinDefaultChannel(tx, invite.workspaceId, user.id, invite.createdById);

        return { email: invite.email, workspaceId: invite.workspaceId };
      });
    } catch (err) {
      if (err instanceof InviteAcceptError) {
        throw new BadRequestException({ error: err.code, detail: err.message });
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException({
          error: "email_taken",
          detail: "An account with this email already exists.",
        });
      }
      throw err;
    }

    // Fan out: admins watching /settings/team see the pending list shrink
    // (this invite is now accepted) AND the members list grow. Same shape
    // as the pre-NestJS server action.
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId: result.workspaceId,
      scope: "invites",
    });
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId: result.workspaceId,
      scope: "members",
    });

    return result;
  }
}

class InviteAcceptError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
