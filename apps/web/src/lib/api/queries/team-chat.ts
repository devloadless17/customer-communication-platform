import "server-only";



import { api } from "../../api-client";
import type {
  ChannelMessagesPage,
  ChannelPinDto,
  TeamChannelBrowseItemDto,
  TeamChannelDto,
  TeamChannelListItemDto,
  TeamDmListItemDto,
} from "@ccp/shared/team-chat/types";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// ---------------------------------------------------------------------------
// Team chat channels
// ---------------------------------------------------------------------------

export async function listChannelsForUser(): Promise<TeamChannelListItemDto[]> {
  const { items } = await api<{ items: TeamChannelListItemDto[] }>("/api/team-chat/channels");
  return items;
}

/** The viewer's 1:1 DMs, most-recently-active first. */
export async function listDirectMessagesForUser(): Promise<TeamDmListItemDto[]> {
  const { items } = await api<{ items: TeamDmListItemDto[] }>("/api/team-chat/channels/dms");
  return items;
}

/**
 * Metadata for a public channel the viewer hasn't joined. Backs the
 * "join to see this channel" card, so a null result (private / DM / missing)
 * is the signal to 404.
 */
export async function getPublicChannelPreview(
  channelId: string,
): Promise<TeamChannelBrowseItemDto | null> {
  const { channel } = await api<{ channel: TeamChannelBrowseItemDto | null }>(
    `/api/team-chat/channels/${channelId}/preview`,
  );
  return channel;
}

export async function getDefaultChannel(): Promise<TeamChannelDto | null> {
  const { channel } = await api<{ channel: TeamChannelDto | null }>(
    "/api/team-chat/channels/default",
  );
  return channel;
}

export async function getChannelById(channelId: string): Promise<TeamChannelDto | null> {
  const { channel } = await api<{ channel: TeamChannelDto | null }>(
    `/api/team-chat/channels/${channelId}`,
  );
  return channel;
}

export async function listChannelMessages(
  channelId: string,
  opts: { take?: number; before?: string } = {},
): Promise<ChannelMessagesPage> {
  return api<ChannelMessagesPage>(`/api/team-chat/channels/${channelId}/messages`, {
    query: { take: opts.take, before: opts.before },
  });
}

export async function listChannelPins(channelId: string): Promise<ChannelPinDto[]> {
  const { pins } = await api<{ pins: ChannelPinDto[] }>(
    `/api/team-chat/channels/${channelId}/pins`,
  );
  return pins;
}

