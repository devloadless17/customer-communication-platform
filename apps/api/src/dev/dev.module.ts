import { Module } from "@nestjs/common";

import { RealtimeModule } from "../realtime/realtime.module";
import { DevEmitController } from "./dev-emit.controller";

/**
 * Dev-only routes. Gated at runtime by `ENABLE_DEV_TOOLS=1`; the controller
 * itself returns 404 in production. Always registered in the module graph
 * so a turning the flag on/off doesn't require a redeploy.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [DevEmitController],
})
export class DevModule {}
