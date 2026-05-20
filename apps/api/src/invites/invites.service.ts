import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { generateInviteToken, hashInviteToken, inviteExpiry } from "@/auth/invite-token";
import { hashPassword } from "@/auth/password";
import { assignableRoles } from "@ccp/shared/auth/permissions";
import type { Role } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type { AcceptInviteInput, CreateInviteInput } from "./invites.schemas";

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
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /** List PENDING (un-accepted, un-expired) invites for the team. */
  async list(teamId: string): Promise<InviteListDto[]> {
    const rows = await this.db.invite.findMany({
      where: {
        teamId,
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
    teamId: string,
    inviterRole: Role,
    inviterUserId: string,
    originUrl: string,
    input: CreateInviteInput,
  ): Promise<InviteCreateDto> {
    const allowed = assignableRoles(inviterRole);
    const requestedRole =
      input.role && (allowed as string[]).includes(input.role)
        ? (input.role as Role)
        : null;
    const role: Role = requestedRole ?? "agent";
    if (!allowed.includes(role)) {
      throw new ForbiddenException({ error: "role not assignable by you" });
    }

    // User.email is globally unique — friendly error before we create an
    // invite that could never be accepted anyway.
    const existingUser = await this.db.user.findUnique({ where: { email: input.email } });
    if (existingUser) {
      throw new ConflictException({ error: "email already in use" });
    }

    // Wipe prior pending invites for this (team, email) so the new link
    // is the only valid one (re-invite UX). Opportunistically drop EXPIRED
    // invites for this team in the same query — keeps the table clean
    // without a cron.
    await this.db.invite.deleteMany({
      where: {
        teamId,
        acceptedAt: null,
        OR: [{ email: input.email }, { expiresAt: { lt: new Date() } }],
      },
    });

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);
    const invite = await this.db.invite.create({
      data: {
        teamId,
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

    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "invites" });

    return { id: invite.id, expiresAt: invite.expiresAt.toISOString(), url };
  }

  /**
   * Revoke a PENDING invite by hard-deleting the row. Already-accepted
   * invites are historical audit rows; admins remove the resulting User
   * via /api/users/[id] instead. Scope by teamId so a foreign id can never
   * match and an already-accepted invite is treated as "not found".
   */
  async revoke(teamId: string, id: string): Promise<void> {
    const result = await this.db.invite.deleteMany({
      where: { id, teamId, acceptedAt: null },
    });
    if (result.count === 0) throw new NotFoundException({ error: "invite not found" });
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "invites" });
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
        team: { select: { name: true } },
      },
    });
    if (!invite) return { status: "invalid", invite: null };
    if (invite.acceptedAt) {
      return {
        status: "used",
        invite: {
          email: invite.email,
          role: invite.role as Role,
          teamName: invite.team?.name ?? "your team",
        },
      };
    }
    if (invite.expiresAt < new Date()) {
      return {
        status: "expired",
        invite: {
          email: invite.email,
          role: invite.role as Role,
          teamName: invite.team?.name ?? "your team",
        },
      };
    }
    return {
      status: "valid",
      invite: {
        email: invite.email,
        role: invite.role as Role,
        teamName: invite.team?.name ?? "your team",
      },
    };
  }

  /**
   * Accept an invite: validate the token + password, create the User +
   * Better-Auth `Account` row + stamp `acceptedAt` in one transaction,
   * publish catalog events. Returns the email + teamId so the (web-side)
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
  ): Promise<{ email: string; teamId: string }> {
    const tokenHash = hashInviteToken(input.token);
    const passwordHash = await hashPassword(input.password);

    let result: { email: string; teamId: string };
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

        const user = await tx.user.create({
          data: {
            teamId: invite.teamId,
            role: invite.role,
            name: input.name,
            email: invite.email,
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
        const defaultChannel = await tx.teamChannel.findFirst({
          where: { teamId: invite.teamId, isDefault: true },
          select: { id: true },
        });
        if (defaultChannel) {
          await tx.teamChannelMember.create({
            data: {
              channelId: defaultChannel.id,
              userId: user.id,
              addedById: invite.createdById,
            },
          });
        }

        return { email: invite.email, teamId: invite.teamId };
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
      teamId: result.teamId,
      scope: "invites",
    });
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId: result.teamId,
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
