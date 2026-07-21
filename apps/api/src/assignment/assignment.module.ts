import { Module, OnModuleInit } from "@nestjs/common";
import {
  AssignmentEligibility,
  AssignmentOverflow,
  AssignmentStrategy,
} from "@prisma/client";

import { assertAssignmentEnumParity } from "@/lib/assignment/select";

import { AssignmentCatalogController } from "./assignment-catalog.controller";
import { AssignmentController } from "./assignment.controller";
import { AssignmentService } from "./assignment.service";
import { AutoAssignSubscriber } from "./auto-assign.subscriber";

/**
 * Assignment routing: the settings API, plus the subscriber that routes
 * inbound conversations. The engine itself is framework-agnostic
 * (`lib/assignment/**`) — this module only wires it into NestJS.
 */
@Module({
  controllers: [AssignmentController, AssignmentCatalogController],
  providers: [AssignmentService, AutoAssignSubscriber],
  exports: [AssignmentService],
})
export class AssignmentModule implements OnModuleInit {
  /**
   * Fail the boot if the Prisma enums and the hand-written `@ccp/shared` string
   * unions have drifted. `apps/web` can't import @prisma/client, so those
   * unions are the settings UI's only source of truth — a silent drift would
   * mean an admin can save a strategy the editor then can't display. Cheaper to
   * catch here than in production.
   */
  onModuleInit(): void {
    assertAssignmentEnumParity({
      AssignmentStrategy,
      AssignmentEligibility,
      AssignmentOverflow,
    });
  }
}
