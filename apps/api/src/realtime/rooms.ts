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
// Per-user room — every one of a user's sockets joins it on connect. Lets the
// server target an individual user across all their tabs without a team-wide
// broadcast (RT-1: membership-scoped private-channel activity fanout).
export const userRoom = (userId: string) => `user:${userId}`;
