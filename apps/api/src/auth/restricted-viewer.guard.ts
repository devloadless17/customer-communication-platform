import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  applyDecorators,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { isRestrictedViewer } from "@/lib/conversations/visibility";

import { SessionGuard } from "./session.guard";

/**
 * Method/class decorator that DENIES restricted viewers (role=agent under
 * `Workspace.agentConversationVisibility="assigned"`).
 *
 *   @DenyRestrictedViewer()
 *
 * Exists for the bulk-PII surfaces the assigned-only boundary would otherwise
 * leak around: an agent who may only see their own conversations must not be
 * able to export the whole contact book or read every campaign's recipient
 * list (name + phone + delivery outcome per contact). Capability gates don't
 * cover this — `contacts:export` / `broadcasts:manage` default TRUE for
 * agents, and flipping those defaults would change unrestricted workspaces
 * too. Product decision 2026-08-10: contacts BROWSING stays open (a directory
 * is not a secret); bulk export and broadcast reads close.
 *
 * 403 with a stable key, not 404: these are whole surfaces, not one hidden
 * row — the UI hides them for restricted sessions, so an error here is a
 * direct API poke and deserves an honest "not for your role".
 *
 * Composes the session guard so callers don't double-apply. Admins, managers
 * and agents in "team"-visibility workspaces are unaffected.
 */
export function DenyRestrictedViewer(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseGuards(SessionGuard, RestrictedViewerGuard));
}

@Injectable()
export class RestrictedViewerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) throw new UnauthorizedException();
    if (isRestrictedViewer(session)) {
      throw new ForbiddenException({
        error: "restricted_visibility",
        detail:
          "Agents limited to their assigned conversations can't use this. Ask a workspace admin.",
      });
    }
    return true;
  }
}
