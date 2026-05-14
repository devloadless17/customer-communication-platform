import "server-only";

// Cursors are base64-url JSON — opaque to clients but easy to debug, no extra
// dependency, and the size is fine for two fields.

export interface ConvoCursor {
  lastMessageAt: Date;
  id: string;
}

export function encodeConvoCursor(c: ConvoCursor): string {
  return base64url(JSON.stringify({ t: c.lastMessageAt.toISOString(), i: c.id }));
}

export function parseConvoCursor(raw: string | null): ConvoCursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(base64urlDecode(raw)) as { t?: string; i?: string };
    if (typeof obj.t !== "string" || typeof obj.i !== "string") return null;
    const d = new Date(obj.t);
    if (Number.isNaN(d.getTime())) return null;
    return { lastMessageAt: d, id: obj.i };
  } catch {
    return null;
  }
}

export interface MessageCursor {
  timestamp: Date;
  id: string;
}

export function encodeMessageCursor(c: MessageCursor): string {
  return base64url(JSON.stringify({ t: c.timestamp.toISOString(), i: c.id }));
}

export function parseMessageCursor(raw: string | null): MessageCursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(base64urlDecode(raw)) as { t?: string; i?: string };
    if (typeof obj.t !== "string" || typeof obj.i !== "string") return null;
    const d = new Date(obj.t);
    if (Number.isNaN(d.getTime())) return null;
    return { timestamp: d, id: obj.i };
  } catch {
    return null;
  }
}

export interface ContactCursor {
  sortAt: Date;
  id: string;
}

export function encodeContactCursor(c: ContactCursor): string {
  return base64url(JSON.stringify({ t: c.sortAt.toISOString(), i: c.id }));
}

export function parseContactCursor(raw: string | null): ContactCursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(base64urlDecode(raw)) as { t?: string; i?: string };
    if (typeof obj.t !== "string" || typeof obj.i !== "string") return null;
    const d = new Date(obj.t);
    if (Number.isNaN(d.getTime())) return null;
    return { sortAt: d, id: obj.i };
  } catch {
    return null;
  }
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}
