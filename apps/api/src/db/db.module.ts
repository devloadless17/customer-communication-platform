import { Global, Module } from "@nestjs/common";

import { DbService } from "./db.service";

/**
 * Global so feature modules can inject DbService without explicit
 * imports. Keeps controllers/services lean — every read in this app
 * eventually touches Prisma.
 */
@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
