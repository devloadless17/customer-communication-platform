import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
  applyDecorators,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { DbService } from "../db/db.service";
import {
  assertCanViewConversation,
  ConversationNotVisibleError,
  isRestrictedViewer,
} from "@/lib/conversations/visibility";
import { SessionGuard } from "./session.guard";

const PARAM_KEY = "ccp:conversation-visibility-param";

/**
 * Enforces the agent conversation-visibility boundary on any route keyed by a
 * conversation id.
 *
 *   @ScopedByConversation()            // reads req.params.id
 *   @ScopedByConversation("conversationId")
 *
 * Applied at the CLASS level it covers every route in that controller that has
 * the named param — including routes added later. That default-on posture is
 * the whole point: a visibility check you must remember to add to each new
 * endpoint is a check that will eventually be missed, and missing it here
 * means showing one customer's messages to the wrong agent.
 *
 * Routes in the same controller WITHOUT the param (list, counts) are ignored —
 * those carry no single conversation to check and scope themselves inside the
 * query instead (`visibilityWhere`).
 *
 * Unrestricted viewers — admin, manager, superAdmin, and every member of a team
 * that hasn't turned this on — short-circuit with ZERO queries, so an
 * un-configured org pays nothing.
 *
 * Always 404, never 403: a 403 confirms the conversation exists to someone who
 * isn't allowed to know that.
 */
export function ScopedByConversation(
  param = "id",
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(PARAM_KEY, param),
    UseGuards(SessionGuard, ConversationVisibilityGuard),
  );
}

@Injectable()
export class ConversationVisibilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const param = this.reflector.getAllAndOverride<string | undefined>(PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!param) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) throw new UnauthorizedException();
    if (!isRestrictedViewer(session)) return true;

    // Route param first, then the BODY. Write routes (`POST /api/messages`,
    // reactions, typing) carry the conversation in the payload, and those are
    // the ones that matter most: sending into a thread you can't see puts words
    // in front of a customer on a colleague's conversation.
    const fromParam = (req.params as Record<string, unknown> | undefined)?.[param];
    const fromBody = (req.body as Record<string, unknown> | undefined)?.[param];
    const conversationId =
      typeof fromParam === "string" && fromParam
        ? fromParam
        : typeof fromBody === "string" && fromBody
          ? fromBody
          : null;
    // Neither present (a list/collection endpoint sharing the controller, or a
    // route keyed by something else) — nothing to check here; those scope
    // inside their own query.
    if (!conversationId) return true;

    // THE visibility rule — lib/conversations/visibility.ts is the single
    // authority ("everything funnels through this file on purpose"); this
    // guard used to hand-roll the same where-fragment, which is exactly the
    // copy-drift §18 warns about. Identical wire shape: 404, never 403.
    try {
      await assertCanViewConversation(this.db, session, conversationId);
    } catch (err) {
      if (err instanceof ConversationNotVisibleError) {
        throw new NotFoundException({ error: "conversation_not_found" });
      }
      throw err;
    }
    return true;
  }
}
