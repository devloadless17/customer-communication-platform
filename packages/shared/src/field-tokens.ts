import type { Prisma } from "@prisma/client";

import type { ContactFieldDefinition } from "./types";

/**
 * Field-token syntax for per-recipient / per-agent substitution in
 * user-authored text.
 *
 * Anywhere we accept agent-typed copy that needs personalization — broadcast
 * variable inputs, snippet bodies, webhook URLs/headers — tokens look like
 * `$var.<namespace>.<field>`:
 *
 *   $var.contact.name              → Contact.name
 *   $var.contact.phone             → Contact.phoneNumber
 *   $var.contact.email             → Contact.email (nullable)
 *   $var.contact.location          → Contact.location (nullable)
 *   $var.contact.<custom_field_key> → Contact.customFields[<custom_field_key>]
 *   $var.agent.name                → User.name (the agent inserting the snippet)
 *   $var.agent.email               → User.email
 *
 * The `$var.` prefix is intentionally distinct from Meta's positional `{{n}}`
 * placeholders so the two systems can coexist inside the same template body
 * without ambiguity. Meta only sees a fully-resolved string — tokens are an
 * app-level concept the runner substitutes before the send.
 *
 * Namespace opt-in: only consumers that pass an agent context (snippets, when
 * an agent inserts) get `$var.agent.*` resolved. Broadcasts and other fan-out
 * surfaces leave agent off — there's no single "agent" for a 1-to-many send.
 */

const BUILTIN_CONTACT_KEYS = ["name", "phone", "email", "location"] as const;
type BuiltinContactKey = (typeof BUILTIN_CONTACT_KEYS)[number];

const BUILTIN_AGENT_KEYS = ["name", "email"] as const;
type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

const MESSAGE_KEYS = [
  "body",
  "timestamp",
  "direction",
  "id",
  "external_id",
  "media_kind",
  "media_caption",
] as const;
type MessageKey = (typeof MESSAGE_KEYS)[number];

const CONVERSATION_KEYS = [
  "id",
  "status",
  "assigned_user_id",
  "unread_count",
  "last_message_at",
] as const;
type ConversationKey = (typeof CONVERSATION_KEYS)[number];

export type TokenNamespace = "contact" | "agent" | "message" | "conversation";

/**
 * One token the picker UI can offer. `token` is what gets inserted into the
 * text input ("$var.contact.name"); `label` is what the agent sees in the
 * dropdown.
 */
export interface TokenSpec {
  token: string;
  label: string;
  /**
   * "builtin" / "custom" are contact fields; "agent" is the agent namespace;
   * "message" / "conversation" are workflow trigger-context fields exposed
   * inside the step editor.
   */
  group: "builtin" | "custom" | "agent" | "message" | "conversation";
}

const BUILTIN_CONTACT_TOKENS: TokenSpec[] = [
  { token: "$var.contact.name", label: "Contact name", group: "builtin" },
  { token: "$var.contact.phone", label: "Phone number", group: "builtin" },
  { token: "$var.contact.email", label: "Email", group: "builtin" },
  { token: "$var.contact.location", label: "Location", group: "builtin" },
];

const AGENT_TOKENS: TokenSpec[] = [
  { token: "$var.agent.name", label: "Agent name", group: "agent" },
  { token: "$var.agent.email", label: "Agent email", group: "agent" },
];

const MESSAGE_TOKENS: TokenSpec[] = [
  { token: "$var.message.body", label: "Message text", group: "message" },
  { token: "$var.message.timestamp", label: "Sent at", group: "message" },
  { token: "$var.message.direction", label: "Direction (in/out)", group: "message" },
  { token: "$var.message.id", label: "Message id", group: "message" },
  { token: "$var.message.external_id", label: "External id (wamid)", group: "message" },
  { token: "$var.message.media_kind", label: "Media kind", group: "message" },
  { token: "$var.message.media_caption", label: "Media caption", group: "message" },
];

const CONVERSATION_TOKENS: TokenSpec[] = [
  { token: "$var.conversation.id", label: "Conversation id", group: "conversation" },
  { token: "$var.conversation.status", label: "Status", group: "conversation" },
  { token: "$var.conversation.assigned_user_id", label: "Assigned user id", group: "conversation" },
  { token: "$var.conversation.unread_count", label: "Unread count", group: "conversation" },
  { token: "$var.conversation.last_message_at", label: "Last message at", group: "conversation" },
];

export interface TokenContextOptions {
  /** Include `$var.agent.*` in pickers and accept it as a "known" token. */
  includeAgent?: boolean;
  /** Include `$var.message.*` — only meaningful for triggers that carry a message. */
  includeMessage?: boolean;
  /** Include `$var.conversation.*` — only for triggers that carry a conversation. */
  includeConversation?: boolean;
}

/**
 * The full list of tokens the picker should show for this team. Built-ins
 * always appear first; custom fields follow in the order admins configured;
 * agent tokens (when opted in) come last.
 */
export function listAvailableTokens(
  fieldDefinitions: ContactFieldDefinition[],
  options: TokenContextOptions = {},
): TokenSpec[] {
  const customs: TokenSpec[] = fieldDefinitions.map((def) => ({
    token: `$var.contact.${def.key}`,
    label: def.label,
    group: "custom" as const,
  }));
  const message = options.includeMessage ? MESSAGE_TOKENS : [];
  const conversation = options.includeConversation ? CONVERSATION_TOKENS : [];
  const agent = options.includeAgent ? AGENT_TOKENS : [];
  return [
    ...BUILTIN_CONTACT_TOKENS,
    ...customs,
    ...message,
    ...conversation,
    ...agent,
  ];
}

/**
 * Regex for `$var.<namespace>.<field>`.
 *
 * Word-boundary on the trailing side (`\b`) so adjacent punctuation in
 * normal prose ("Hi $var.contact.name, …") doesn't get sucked into the
 * field name. The lookbehind on the leading side guards against accidental
 * matches inside identifiers like `email$var.contact.name`.
 */
const TOKEN_RE =
  /(?<![A-Za-z0-9_])\$var\.(contact|agent|message|conversation)\.([a-z][a-z0-9_]*)\b/g;

/**
 * Extract the fully-qualified tokens present in `text` (e.g.
 * `"$var.contact.name"`, `"$var.agent.email"`). Each unique token appears
 * once. Used by `findUnknownTokens` and consumers that want to know what's
 * referenced.
 */
export function extractFieldTokens(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset lastIndex defensively — the regex is module-scope.
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.add(m[0]);
  }
  return Array.from(out);
}

/**
 * Same shape the broadcast runner already passes around — defined here so
 * downstream callers don't have to import the runner just to type a Contact
 * argument.
 */
export interface ContactLike {
  name: string;
  // Nullable post the multi-channel refactor — Instagram/Telegram contacts
  // have no phone. Token resolver substitutes empty string when null, same
  // as for any other empty field.
  phoneNumber: string | null;
  // Optional in both senses (DB row uses null; UI Contact dto omits the
  // field entirely when absent). Resolvers fall back to empty string.
  email?: string | null;
  location?: string | null;
  customFields: Prisma.JsonValue;
}

/**
 * Minimum we need to resolve `$var.agent.*`. Matches the shape of `User` in
 * lib/types so callers can pass `currentUser` straight in.
 */
export interface AgentLike {
  name: string;
  email: string;
}

/**
 * Trigger-message context used by workflow step handlers to resolve
 * `$var.message.*`. Shape matches `WorkflowMessageSnapshot` so callers can
 * pass an envelope snapshot directly without remapping.
 */
export interface MessageLike {
  id?: string;
  externalId?: string;
  body?: string;
  direction?: "in" | "out";
  timestamp?: string;
  mediaKind?: string | null;
  mediaCaption?: string | null;
}

/**
 * Trigger-conversation context for `$var.conversation.*`. Subset of the
 * envelope conversation snapshot; the rest of the snapshot's analytics
 * fields aren't exposed yet — add them token-by-token here when needed.
 */
export interface ConversationLike {
  id?: string;
  status?: string;
  assignedUserId?: string | null;
  unreadCount?: number;
  lastMessageAt?: string;
}

/**
 * Replace every `$var.<namespace>.<field>` in `text` with the matching value
 * from `contact` (or `agent`, when provided). Unknown fields resolve to an
 * empty string (NOT left as the raw token) so we never accidentally ship
 * literal "$var.contact.foo" to a customer's WhatsApp. The form's
 * `findUnknownTokens` warns the author before they get here so this
 * empty-string fallback is mostly a safety net.
 *
 * Tokens are matched case-sensitively (lowercase + underscore only) so a
 * stray "$Var.Contact.Name" stays in the output — that's a typo the agent
 * should fix, not silently rewrite for them.
 *
 * `agent` is optional: when omitted (broadcast send, automation envelope),
 * `$var.agent.*` resolves to empty. The author shouldn't have typed it.
 */
export interface ResolverExtras {
  agent?: AgentLike | null;
  message?: MessageLike | null;
  conversation?: ConversationLike | null;
}

export function resolveFieldTokens(
  text: string,
  contact: ContactLike,
  extrasOrAgent?: ResolverExtras | AgentLike | null,
): string {
  // Backwards-compat: callers used to pass `agent` directly as the third
  // arg. Detect the bare AgentLike shape and re-wrap; anything else is
  // either null/undefined or the new ResolverExtras object.
  const extras: ResolverExtras =
    extrasOrAgent && "name" in extrasOrAgent && "email" in extrasOrAgent
      ? { agent: extrasOrAgent as AgentLike }
      : (extrasOrAgent as ResolverExtras | null | undefined) ?? {};
  return text.replace(
    /(?<![A-Za-z0-9_])\$var\.(contact|agent|message|conversation)\.([a-z][a-z0-9_]*)\b/g,
    (_, namespace: string, key: string) => {
      if (namespace === "agent") return resolveAgent(key, extras.agent ?? null);
      if (namespace === "message") return resolveMessage(key, extras.message ?? null);
      if (namespace === "conversation") {
        return resolveConversation(key, extras.conversation ?? null);
      }
      return resolveContact(key, contact);
    },
  );
}

function resolveContact(key: string, contact: ContactLike): string {
  if (BUILTIN_CONTACT_KEYS.includes(key as BuiltinContactKey)) {
    switch (key as BuiltinContactKey) {
      case "name":
        return contact.name ?? "";
      case "phone":
        return contact.phoneNumber ?? "";
      case "email":
        return contact.email ?? "";
      case "location":
        return contact.location ?? "";
      default:
        return "";
    }
  }
  const bag =
    contact.customFields &&
    typeof contact.customFields === "object" &&
    !Array.isArray(contact.customFields)
      ? (contact.customFields as Record<string, unknown>)
      : {};
  const v = bag[key];
  return typeof v === "string" ? v : "";
}

function resolveAgent(key: string, agent: AgentLike | null | undefined): string {
  if (!agent) return "";
  if (!BUILTIN_AGENT_KEYS.includes(key as BuiltinAgentKey)) return "";
  switch (key as BuiltinAgentKey) {
    case "name":
      return agent.name ?? "";
    case "email":
      return agent.email ?? "";
    default:
      return "";
  }
}

function resolveMessage(key: string, message: MessageLike | null): string {
  if (!message) return "";
  if (!MESSAGE_KEYS.includes(key as MessageKey)) return "";
  switch (key as MessageKey) {
    case "body":
      return message.body ?? "";
    case "timestamp":
      return message.timestamp ?? "";
    case "direction":
      return message.direction ?? "";
    case "id":
      return message.id ?? "";
    case "external_id":
      return message.externalId ?? "";
    case "media_kind":
      return message.mediaKind ?? "";
    case "media_caption":
      return message.mediaCaption ?? "";
    default:
      return "";
  }
}

function resolveConversation(
  key: string,
  conversation: ConversationLike | null,
): string {
  if (!conversation) return "";
  if (!CONVERSATION_KEYS.includes(key as ConversationKey)) return "";
  switch (key as ConversationKey) {
    case "id":
      return conversation.id ?? "";
    case "status":
      return conversation.status ?? "";
    case "assigned_user_id":
      return conversation.assignedUserId ?? "";
    case "unread_count":
      return conversation.unreadCount == null
        ? ""
        : String(conversation.unreadCount);
    case "last_message_at":
      return conversation.lastMessageAt ?? "";
    default:
      return "";
  }
}

/**
 * Render the token string with a SAMPLE contact, for the live preview the
 * broadcast form shows under each variable input. Sample values mirror what
 * a real recipient would see for the same token, so what-you-see-is-what-
 * you-send.
 */
export const SAMPLE_CONTACT: ContactLike = {
  name: "Sara Khalil",
  phoneNumber: "15551234567",
  email: "sara@example.com",
  location: "Beirut",
  customFields: {} as Prisma.JsonValue,
};

/**
 * Sample agent for live previews in surfaces that resolve `$var.agent.*`
 * (snippets editor today; could grow). Distinct from SAMPLE_CONTACT so the
 * preview clearly shows which value comes from which namespace.
 */
export const SAMPLE_AGENT: AgentLike = {
  name: "Alex Doe",
  email: "alex@yourteam.com",
};

/**
 * Return the set of fully-qualified tokens in `text` that DON'T resolve
 * against the provided field schema (and, if `includeAgent`, the agent
 * namespace). Used by forms to highlight typos before send.
 *
 * Returns strings like `"$var.contact.foo"` so callers can render them
 * directly.
 */
export function findUnknownTokens(
  text: string,
  fieldDefinitions: ContactFieldDefinition[],
  options: TokenContextOptions = {},
): string[] {
  const contactKeys = new Set<string>([
    ...BUILTIN_CONTACT_KEYS,
    ...fieldDefinitions.map((d) => d.key),
  ]);
  const agentKeys = options.includeAgent
    ? new Set<string>(BUILTIN_AGENT_KEYS)
    : null;
  const messageKeys = options.includeMessage
    ? new Set<string>(MESSAGE_KEYS)
    : null;
  const conversationKeys = options.includeConversation
    ? new Set<string>(CONVERSATION_KEYS)
    : null;
  const out: string[] = [];
  for (const tok of extractFieldTokens(text)) {
    // tok looks like "$var.<namespace>.<key>". Split once.
    const rest = tok.slice("$var.".length);
    const dot = rest.indexOf(".");
    if (dot === -1) continue;
    const namespace = rest.slice(0, dot);
    const key = rest.slice(dot + 1);
    if (namespace === "contact") {
      if (!contactKeys.has(key)) out.push(tok);
    } else if (namespace === "agent") {
      if (!agentKeys || !agentKeys.has(key)) out.push(tok);
    } else if (namespace === "message") {
      if (!messageKeys || !messageKeys.has(key)) out.push(tok);
    } else if (namespace === "conversation") {
      if (!conversationKeys || !conversationKeys.has(key)) out.push(tok);
    } else {
      out.push(tok);
    }
  }
  return out;
}
