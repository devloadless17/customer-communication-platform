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

/** One recorded crossing into a customer organization by the platform operator. */
export interface OperatorAccessEntry {
  id: string;
  userId: string;
  /** Null once the account or the workspace has been deleted — both are plain
   *  ids on the row on purpose, so the visit outlives what it visited. */
  operatorName: string | null;
  operatorEmail: string | null;
  workspaceId: string;
  workspaceName: string | null;
  createdAt: string;
}

/**
 * The operator-entry log for one organization, newest first.
 *
 * Read on the org detail page so entering a tenant is visible AFTER the fact,
 * next to the button that does it. Best-effort at the call site: an audit panel
 * that fails to load must not take the management page down with it.
 */
export async function listOperatorAccess(
  organizationId: string,
): Promise<OperatorAccessEntry[]> {
  const { entries } = await api<{ entries: OperatorAccessEntry[] }>(
    `/api/admin/operator-access?organizationId=${encodeURIComponent(organizationId)}`,
  );
  return entries;
}

export async function getPlatformAnalytics(): Promise<PlatformAnalytics> {
  return api<PlatformAnalytics>("/api/admin/analytics");
}

export async function getPlatformOps(): Promise<PlatformOpsSnapshot> {
  return api<PlatformOpsSnapshot>("/api/admin/analytics/ops");
}

