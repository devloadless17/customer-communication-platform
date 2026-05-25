/**
 * Socket.io room name conventions. The single source of truth for room names
 * shared by the gateway, the fanout rules, and every emitter.
 */
export const teamRoom = (teamId: string) => `team:${teamId}`;
export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;
export const channelRoom = (channelId: string) => `chan:${channelId}`;
