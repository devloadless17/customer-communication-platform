import { Injectable } from "@nestjs/common";

/**
 * Per-target typing tracker. The "target" is either a conversation id (for
 * customer threads) or a team-chat channel id. Two separate maps so a key
 * collision is structurally impossible.
 */
@Injectable()
export class TypingService {
  private readonly conv = new Map<string, Map<string, Set<string>>>();
  private readonly chan = new Map<string, Map<string, Set<string>>>();
  // Keyed by threadRootId — globally unique across channels.
  private readonly thread = new Map<string, Map<string, Set<string>>>();

  addConv(conversationId: string, userId: string, socketId: string): void {
    addInto(this.conv, conversationId, userId, socketId);
  }
  removeConv(conversationId: string, userId: string, socketId: string): void {
    removeFrom(this.conv, conversationId, userId, socketId);
  }
  snapshotConv(conversationId: string): string[] {
    return snapshotOf(this.conv, conversationId);
  }

  addChannel(channelId: string, userId: string, socketId: string): void {
    addInto(this.chan, channelId, userId, socketId);
  }
  removeChannel(channelId: string, userId: string, socketId: string): void {
    removeFrom(this.chan, channelId, userId, socketId);
  }
  snapshotChannel(channelId: string): string[] {
    return snapshotOf(this.chan, channelId);
  }

  addThread(threadRootId: string, userId: string, socketId: string): void {
    addInto(this.thread, threadRootId, userId, socketId);
  }
  removeThread(threadRootId: string, userId: string, socketId: string): void {
    removeFrom(this.thread, threadRootId, userId, socketId);
  }
  snapshotThread(threadRootId: string): string[] {
    return snapshotOf(this.thread, threadRootId);
  }
}

function addInto(
  store: Map<string, Map<string, Set<string>>>,
  key: string,
  userId: string,
  socketId: string,
): void {
  const inner = store.get(key) ?? new Map<string, Set<string>>();
  const sockets = inner.get(userId) ?? new Set<string>();
  sockets.add(socketId);
  inner.set(userId, sockets);
  store.set(key, inner);
}

function removeFrom(
  store: Map<string, Map<string, Set<string>>>,
  key: string,
  userId: string,
  socketId: string,
): void {
  const inner = store.get(key);
  if (!inner) return;
  const sockets = inner.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) inner.delete(userId);
  if (inner.size === 0) store.delete(key);
}

function snapshotOf(
  store: Map<string, Map<string, Set<string>>>,
  key: string,
): string[] {
  const inner = store.get(key);
  return inner ? [...inner.keys()] : [];
}
