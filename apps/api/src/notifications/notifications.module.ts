import { Module } from "@nestjs/common";

import { DbModule } from "../db/db.module";

import { NotificationsController } from "./notifications.controller";

/**
 * The bell. Thin by design — every rule lives in `lib/notifications`, and this
 * module only supplies `this.db` and the session guard.
 */
@Module({ imports: [DbModule], controllers: [NotificationsController] })
export class NotificationsModule {}
