/**
 * Socket.io room name conventions. Mirrors lib/socket/server.ts exactly so
 * subscribers / emitters can be migrated in either direction without a
 * rename.
 */
export const teamRoom = (teamId: string) => `team:${teamId}`;
export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;
export const channelRoom = (channelId: string) => `chan:${channelId}`;
export const channelThreadRoom = (rootMessageId: string) => `chan-thr:${rootMessageId}`;
