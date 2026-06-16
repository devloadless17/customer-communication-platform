/**
 * Socket.io room name conventions. The single source of truth for room names
 * shared by the gateway, the fanout rules, and every emitter.
 */
export const teamRoom = (teamId: string) => `team:${teamId}`;
export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;
export const channelRoom = (channelId: string) => `chan:${channelId}`;
// Per-user room — every one of a user's sockets joins it on connect. Lets the
// server target an individual user across all their tabs without a team-wide
// broadcast (RT-1: membership-scoped private-channel activity fanout).
export const userRoom = (userId: string) => `user:${userId}`;
