/**
 * Room name for a visitor's conversation on the "/widget" Socket.io namespace.
 * A visitor socket only ever joins the room for THEIR OWN conversation (resolved
 * server-side from the site key + visitor id), so the room is the delivery target
 * for agent replies + status updates. Distinct prefix from the agent-side rooms
 * (rooms.ts in realtime/) since this is a separate namespace.
 */
export const widgetRoom = (conversationId: string) => `widget:conv:${conversationId}`;
