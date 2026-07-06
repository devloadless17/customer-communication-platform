import { z } from "zod";

import { ALL_CAPABILITIES, type Capability } from "./permissions";

/**
 * Zod schema for the PATCH body / stored value. Only editable roles, only
 * known capabilities, only booleans. `admin`/`superAdmin` keys are rejected so
 * a malformed write can't claim to lock out the owner. `.strict()` rejects
 * unknown role keys.
 *
 * Kept in its own subpath (not the `./permissions` barrel) so zod's runtime
 * (~64KB gz) stays OUT of any client bundle that only needs the plain
 * permission predicates. The sole consumer is the NestJS permissions
 * controller — import from "@ccp/shared/auth/permissions-schema".
 */
const zCapabilityMap = z
  .object(
    ALL_CAPABILITIES.reduce(
      (acc, cap) => {
        acc[cap] = z.boolean().optional();
        return acc;
      },
      {} as Record<Capability, z.ZodOptional<z.ZodBoolean>>,
    ),
  )
  .strict();

export const zRolePermissions = z
  .object({
    manager: zCapabilityMap.optional(),
    agent: zCapabilityMap.optional(),
  })
  .strict();
