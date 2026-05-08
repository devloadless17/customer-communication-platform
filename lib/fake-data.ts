import type {
  Contact,
  Conversation,
  ConversationWithRefs,
  InternalNote,
  Message,
  Team,
  User,
} from "@/lib/types";

/**
 * Static fake data for Phase 0 (UI-only). Shapes match the Prisma schema we'll
 * generate in Week 1 — when we swap to real DB rows, the UI shouldn't change.
 *
 * Timestamps are anchored to a fixed reference so the layout looks stable in
 * screenshots, but `formatListTime` will still render them relative to "now",
 * which is what we want.
 */

const TEAM_ID = "team_1";

export const fakeTeam: Team = {
  id: TEAM_ID,
  name: "Loadless Support",
};

export const fakeUsers: User[] = [
  { id: "u_me", teamId: TEAM_ID, role: "superAdmin", name: "Ali Al-Ahmad", email: "ali@loadless.ai" },
  { id: "u_sara", teamId: TEAM_ID, role: "admin", name: "Sara Khalil", email: "sara@loadless.ai" },
  { id: "u_omar", teamId: TEAM_ID, role: "manager", name: "Omar Reyes", email: "omar@loadless.ai" },
  { id: "u_lina", teamId: TEAM_ID, role: "agent", name: "Lina Becker", email: "lina@loadless.ai" },
];

/** The currently signed-in user (placeholder until NextAuth wires up Week 1). */
export const currentUser: User = fakeUsers[0]!;

const userById = new Map(fakeUsers.map((u) => [u.id, u]));
export function getUser(id: string | null): User | null {
  return id ? userById.get(id) ?? null : null;
}

// ---------------------------------------------------------------------------
// Time helpers — produce a stable ISO ladder of timestamps.
// ---------------------------------------------------------------------------

// Anchor to "now at seed time" so seed timestamps are always recent relative
// to when the DB was seeded — keeps "12m ago", "3h ago" etc. realistic.
const ANCHOR = Date.now();

function ago(minutes: number): string {
  return new Date(ANCHOR - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const fakeContacts: Contact[] = [
  { id: "c_amelia", teamId: TEAM_ID, phoneNumber: "+447911123456", name: "Amelia Carter", customFields: {}, source: "inbound" },
  { id: "c_jamal", teamId: TEAM_ID, phoneNumber: "+201001234567", name: "Jamal El-Sayed", customFields: {}, source: "inbound" },
  { id: "c_sven", teamId: TEAM_ID, phoneNumber: "+4915112345678", name: "Sven Rodriguez", customFields: {}, source: "inbound" },
  { id: "c_priya", teamId: TEAM_ID, phoneNumber: "+919876543210", name: "Priya Nair", customFields: {}, source: "inbound" },
  { id: "c_unknown", teamId: TEAM_ID, phoneNumber: "+13105550199", name: "+1 310 555 0199", customFields: {}, source: "inbound" },
  { id: "c_marco", teamId: TEAM_ID, phoneNumber: "+393331234567", name: "Marco Bianchi", customFields: {}, source: "inbound" },
  { id: "c_yuki", teamId: TEAM_ID, phoneNumber: "+819012345678", name: "Yuki Tanaka", customFields: {}, source: "inbound" },
  { id: "c_brigitte", teamId: TEAM_ID, phoneNumber: "+33612345678", name: "Brigitte Laurent", customFields: {}, source: "inbound" },
  { id: "c_kwame", teamId: TEAM_ID, phoneNumber: "+233244123456", name: "Kwame Osei", customFields: {}, source: "inbound" },
  { id: "c_olivia", teamId: TEAM_ID, phoneNumber: "+61412345678", name: "Olivia Ng", customFields: {}, source: "inbound" },
];

const contactById = new Map(fakeContacts.map((c) => [c.id, c]));
export function getContact(id: string): Contact {
  const c = contactById.get(id);
  if (!c) throw new Error(`Unknown contact ${id}`);
  return c;
}

// ---------------------------------------------------------------------------
// Conversations + their messages/notes.
//
// Authored in long-form so the UI gets to render real-feeling threads. Each
// conversation has a different shape: assignment state, status, unread, mix
// of inbound/outbound, and optional notes.
// ---------------------------------------------------------------------------

interface BuiltConversation {
  conversation: Conversation;
  messages: Message[];
  notes: InternalNote[];
}

function build(
  id: string,
  contactId: string,
  fields: {
    assignedUserId: string | null;
    status: Conversation["status"];
    unreadCount: number;
    messages: Array<
      | { dir: "in"; body: string; minutesAgo: number }
      | {
          dir: "out";
          body: string;
          minutesAgo: number;
          senderUserId: string;
          status?: Message["status"];
        }
    >;
    notes?: Array<{ authorUserId: string; body: string; minutesAgo: number }>;
  },
): BuiltConversation {
  const messages: Message[] = fields.messages.map((m, idx) => ({
    id: `${id}_m_${idx}`,
    teamId: TEAM_ID,
    conversationId: id,
    externalId: `fake_${id}_${idx}`,
    senderUserId: m.dir === "out" ? m.senderUserId : null,
    body: m.body,
    direction: m.dir,
    provider: "meta_cloud",
    status: m.dir === "out" ? m.status ?? "delivered" : "delivered",
    rawPayload: { fake: true },
    timestamp: ago(m.minutesAgo),
  }));

  const notes: InternalNote[] = (fields.notes ?? []).map((n, idx) => ({
    id: `${id}_n_${idx}`,
    conversationId: id,
    authorUserId: n.authorUserId,
    body: n.body,
    timestamp: ago(n.minutesAgo),
  }));

  const last = messages[messages.length - 1]!;

  const conversation: Conversation = {
    id,
    teamId: TEAM_ID,
    contactId,
    assignedUserId: fields.assignedUserId,
    status: fields.status,
    unreadCount: fields.unreadCount,
    lastMessageAt: last.timestamp,
    lastMessagePreview: last.body,
  };

  return { conversation, messages, notes };
}

const built: BuiltConversation[] = [
  build("conv_amelia", "c_amelia", {
    assignedUserId: "u_me",
    status: "open",
    unreadCount: 2,
    messages: [
      { dir: "in", body: "Hi! I just bought the annual plan but I didn't get an invoice email.", minutesAgo: 47 },
      { dir: "in", body: "Could you resend it to amelia@candor.co?", minutesAgo: 46 },
      { dir: "out", body: "Hey Amelia — looking into it now, give me a moment.", minutesAgo: 38, senderUserId: "u_me", status: "read" },
      { dir: "out", body: "Found the order, resending the invoice to that address right now.", minutesAgo: 24, senderUserId: "u_me", status: "read" },
      { dir: "in", body: "Got it, thanks! One more thing — can I switch the billing email later?", minutesAgo: 9 },
      { dir: "in", body: "Or is it locked once the subscription is active?", minutesAgo: 8 },
    ],
    notes: [
      { authorUserId: "u_sara", body: "FYI Stripe shows the invoice as paid, original send bounced — typo in their domain.", minutesAgo: 30 },
    ],
  }),

  build("conv_jamal", "c_jamal", {
    assignedUserId: "u_sara",
    status: "open",
    unreadCount: 1,
    messages: [
      { dir: "in", body: "Salam! The dashboard is loading blank for my whole team since this morning.", minutesAgo: 120 },
      { dir: "out", body: "Hi Jamal — sorry about that. Could you share a screenshot of what you're seeing?", minutesAgo: 110, senderUserId: "u_sara", status: "read" },
      { dir: "in", body: "Sent it to your email just now.", minutesAgo: 90 },
      { dir: "out", body: "Got it, our team is investigating. We'll update you within 30 min.", minutesAgo: 85, senderUserId: "u_sara", status: "read" },
      { dir: "in", body: "Any update? It's been a while.", minutesAgo: 14 },
    ],
    notes: [
      { authorUserId: "u_omar", body: "Their workspace is on the affected shard — incident #2104, ETA 20 min.", minutesAgo: 70 },
    ],
  }),

  build("conv_sven", "c_sven", {
    assignedUserId: null,
    status: "open",
    unreadCount: 1,
    messages: [
      { dir: "in", body: "Hey, can I get a refund? Bought the wrong tier yesterday.", minutesAgo: 35 },
    ],
  }),

  build("conv_priya", "c_priya", {
    assignedUserId: "u_omar",
    status: "pending",
    unreadCount: 0,
    messages: [
      { dir: "in", body: "Trying to integrate the API but I'm getting 401s on every request.", minutesAgo: 600 },
      { dir: "out", body: "Hey Priya — could you confirm you're using the workspace key, not the personal one?", minutesAgo: 590, senderUserId: "u_omar", status: "read" },
      { dir: "in", body: "Oh, hadn't noticed those were different. Let me try.", minutesAgo: 540 },
      { dir: "out", body: "Sounds good, ping me here if it still fails.", minutesAgo: 535, senderUserId: "u_omar", status: "read" },
    ],
  }),

  build("conv_unknown", "c_unknown", {
    assignedUserId: null,
    status: "open",
    unreadCount: 1,
    messages: [
      { dir: "in", body: "Is this loadless? saw your post on linkedin", minutesAgo: 240 },
    ],
  }),

  build("conv_marco", "c_marco", {
    assignedUserId: "u_me",
    status: "open",
    unreadCount: 0,
    messages: [
      { dir: "in", body: "Ciao! Quick one — can I export conversations to CSV?", minutesAgo: 1500 },
      { dir: "out", body: "Hi Marco! Not yet, but it's on the short-term roadmap. I'll DM you when it ships.", minutesAgo: 1490, senderUserId: "u_me", status: "read" },
      { dir: "in", body: "Perfect, grazie!", minutesAgo: 1485 },
    ],
  }),

  build("conv_yuki", "c_yuki", {
    assignedUserId: "u_lina",
    status: "open",
    unreadCount: 0,
    messages: [
      { dir: "in", body: "ありがとう、it's working now!", minutesAgo: 2880 },
      { dir: "out", body: "Glad to hear it Yuki — let me know if anything else comes up.", minutesAgo: 2875, senderUserId: "u_lina", status: "read" },
    ],
  }),

  build("conv_brigitte", "c_brigitte", {
    assignedUserId: "u_sara",
    status: "closed",
    unreadCount: 0,
    messages: [
      { dir: "in", body: "Bonjour, my password reset email never arrived.", minutesAgo: 4400 },
      { dir: "out", body: "Hi Brigitte — I just triggered a fresh one, please check your spam folder too.", minutesAgo: 4390, senderUserId: "u_sara", status: "read" },
      { dir: "in", body: "Found it, all set.", minutesAgo: 4380 },
    ],
  }),

  build("conv_kwame", "c_kwame", {
    assignedUserId: null,
    status: "pending",
    unreadCount: 0,
    messages: [
      { dir: "in", body: "Hello — when will mobile push notifications be available?", minutesAgo: 6000 },
      { dir: "out", body: "Hey Kwame — likely in the next month or so. I'll loop you in once we have a date.", minutesAgo: 5990, senderUserId: "u_omar", status: "read" },
    ],
  }),

  build("conv_olivia", "c_olivia", {
    assignedUserId: "u_me",
    status: "open",
    unreadCount: 0,
    messages: [
      { dir: "in", body: "Heads up — your status page shows a degradation but we're not seeing any issues here.", minutesAgo: 12 },
      { dir: "out", body: "Thanks Olivia, that's an old incident the page didn't auto-close. Fixing now.", minutesAgo: 4, senderUserId: "u_me", status: "delivered" },
    ],
  }),
];

// ---------------------------------------------------------------------------
// Public read API — what the UI imports.
// ---------------------------------------------------------------------------

export const fakeConversations: Conversation[] = built.map((b) => b.conversation);
export const fakeMessages: Message[] = built.flatMap((b) => b.messages);
export const fakeNotes: InternalNote[] = built.flatMap((b) => b.notes);

const builtById = new Map(built.map((b) => [b.conversation.id, b]));

function lastInboundOf(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.direction === "in") return m.timestamp;
  }
  return null;
}

export function getConversationWithRefs(id: string): ConversationWithRefs | null {
  const b = builtById.get(id);
  if (!b) return null;
  return {
    conversation: b.conversation,
    contact: getContact(b.conversation.contactId),
    assignedUser: getUser(b.conversation.assignedUserId),
    messages: b.messages,
    notes: b.notes,
    lastInboundAt: lastInboundOf(b.messages),
  };
}

export function listConversations(): ConversationWithRefs[] {
  return built
    .map((b) => ({
      conversation: b.conversation,
      contact: getContact(b.conversation.contactId),
      assignedUser: getUser(b.conversation.assignedUserId),
      messages: b.messages,
      notes: b.notes,
      lastInboundAt: lastInboundOf(b.messages),
    }))
    .sort(
      (a, b) =>
        new Date(b.conversation.lastMessageAt).getTime() -
        new Date(a.conversation.lastMessageAt).getTime(),
    );
}
