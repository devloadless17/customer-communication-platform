import "server-only";



import { api } from "../../api-client";
import { isApiNotFound } from "./helpers";




import type {
  PlatformAnalytics,
  PlatformOpsSnapshot,
  SuperAdminWorkspaceDetail,
  SuperAdminWorkspaceRow,
  SuperAdminOrgRow,
} from "@ccp/shared/dtos";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// ---------------------------------------------------------------------------
// Super-admin (cross-team)
// ---------------------------------------------------------------------------

export async function listAllWorkspacesForSuperAdmin(): Promise<SuperAdminWorkspaceRow[]> {
  const { workspaces } = await api<{ workspaces: SuperAdminWorkspaceRow[] }>("/api/admin/workspaces");
  return workspaces;
}

/** Organisations with their workspaces nested — what the platform list shows. */
export async function listAllOrgsForSuperAdmin(): Promise<SuperAdminOrgRow[]> {
  const { orgs } = await api<{ orgs: SuperAdminOrgRow[] }>("/api/admin/workspaces");
  return orgs;
}

export async function getWorkspaceDetailForSuperAdmin(
  workspaceId: string,
): Promise<SuperAdminWorkspaceDetail | null> {
  try {
    return await api<SuperAdminWorkspaceDetail>(`/api/admin/workspaces/${workspaceId}`);
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

export async function getPlatformAnalytics(): Promise<PlatformAnalytics> {
  return api<PlatformAnalytics>("/api/admin/analytics");
}

export async function getPlatformOps(): Promise<PlatformOpsSnapshot> {
  return api<PlatformOpsSnapshot>("/api/admin/analytics/ops");
}

