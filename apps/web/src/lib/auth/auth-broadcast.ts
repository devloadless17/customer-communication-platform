"use client";

/**
 * Cross-tab auth signalling. One tab signs out → every other tab in the same
 * browser follows immediately, instead of waiting for its next interaction
 * to trip a 401 and self-redirect.
 *
 * BroadcastChannel never delivers a message back to the tab that posted it,
 * so we don't need any "is this me" gating on the receiver. Single, lazy
 * module-level channel — opening one per call leaks handles on hot-reload.
 */

const CHANNEL_NAME = "ccp-auth";

export type AuthBroadcastMessage = { type: "signout" };

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return channel;
}

export function broadcastSignout(): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: "signout" } satisfies AuthBroadcastMessage);
  } catch {
    // Best-effort — a failed broadcast just means peer tabs fall back to
    // the existing "next interaction trips 401" path. Not worth surfacing.
  }
}

export function subscribeAuthBroadcast(
  onMessage: (msg: AuthBroadcastMessage) => void,
): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const handler = (event: MessageEvent) => {
    const data = event.data as AuthBroadcastMessage | undefined;
    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      return;
    }
    onMessage(data);
  };
  ch.addEventListener("message", handler);
  return () => {
    ch.removeEventListener("message", handler);
  };
}
