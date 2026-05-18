import type { Plan } from "../types";

/**
 * Subscription tiers — scaffolding only.
 *
 * Every team is currently provisioned on `starter` and no features are
 * gated. The matrix below is intentionally empty; predicates land here
 * (mirroring [./permissions.ts](./permissions.ts)) once the product is
 * ready to differentiate plans.
 *
 * Shape when the time comes — one predicate per gated feature, both
 * server and client read through these so flipping a tier is a one-file
 * edit:
 *
 *   export function canUseAiAgents(plan: Plan): boolean {
 *     return plan === "advanced" || plan === "enterprise";
 *   }
 *
 * Until then, this file just exposes the enumeration + a label helper.
 * UI surfaces the plan nowhere yet.
 */

export const ALL_PLANS: Plan[] = ["free", "starter", "advanced", "enterprise"];

/** Pretty label for UI when we eventually surface it. */
export function planLabel(plan: Plan): string {
  switch (plan) {
    case "free":
      return "Free";
    case "starter":
      return "Starter";
    case "advanced":
      return "Advanced";
    case "enterprise":
      return "Enterprise";
  }
}
