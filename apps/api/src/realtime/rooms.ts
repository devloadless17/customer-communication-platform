/**
 * Socket.io room name conventions. The single source of truth for room names
 * shared by the gateway, the fanout rules, and every emitter.
 */
/**
 * Per-WORKSPACE room. Renamed from `team:` when the tenant model became
 * Organization → Workspace: the isolation boundary a socket belongs to is the
 * ACTIVE workspace, so the room name says so. A socket joins exactly one of
 * these, re-resolved on every handshake (and after a workspace switch, which
 * forces a reconnect).
 */
export const workspaceRoom = (workspaceId: string) => `ws:${workspaceId}`;
export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;
export const channelRoom = (channelId: string) => `chan:${channelId}`;
/**
 * Per-user room, SCOPED TO A WORKSPACE. Every one of a user's sockets joins the
 * room for the workspace that socket resolved to. Lets the server target an
 * individual without a workspace-wide broadcast (RT-1: membership-scoped
 * private-channel activity, restricted-agent conversation frames, private
 * availability notes).
 *
 * The workspace is in the key, not just the payload, because the same PERSON
 * can be signed into two workspaces at once — one per browser, since the active
 * workspace is per-device. A bare `user:<id>` room put both sockets in the same
 * bucket, so workspace A's private-channel activity and DM-created frames
 * arrived at a tab scoped to workspace B. Presence frames were filtered by a
 * client-side `payload.workspaceId` check; these were not, and relying on every
 * future consumer to remember that check is the arrangement §10 warns about —
 * scope belongs in room membership, decided once per connection.
 */
export const userRoom = (workspaceId: string, userId: string) =>
  `user:${workspaceId}:${userId}`;
