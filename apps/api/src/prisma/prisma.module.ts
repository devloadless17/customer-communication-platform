import { Global, Module } from "@nestjs/common";

import { PrismaService } from "./prisma.service";

/**
 * Global so feature modules can inject PrismaService without explicit
 * imports. Keeps controllers/services lean — every read in this app
 * eventually touches Prisma.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
