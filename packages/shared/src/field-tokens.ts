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

const BUILTIN_CONTACT_KEYS = [
  "name",
  "phone",
  "email",
  "location",
  // PR 2.4 additions — derivable / populated by the snapshot builder when
  // the call site joins the related rows. Resolve to empty string when
  // the field isn't on the contact (back-compat for older snapshots).
  "last_inbound_at",
  "window_state",
  "stage_name",
  "tag_names",
] as const;
type BuiltinContactKey = (typeof BUILTIN_CONTACT_KEYS)[number];

const BUILTIN_AGENT_KEYS = ["name", "email"] as const;
type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

const MESSAGE_KEYS = [
  "body",
  "timestamp",
  "direction",
  "id",
  "external_id",
  "channel",
  "media_kind",
  "media_caption",
  // PR 2.4 additions.
  "sender_name",
  "media_url",
  "has_media",
] as const;
type MessageKey = (typeof MESSAGE_KEYS)[number];

const CONVERSATION_KEYS = [
  "id",
  "status",
  "assigned_user_id",
  "unread_count",
  "last_message_at",
  // PR 2.4 additions.
  "has_unread",
  "assigned_agent_name",
  "assigned_agent_email",
] as const;
type ConversationKey = (typeof CONVERSATION_KEYS)[number];

export type TokenNamespace =
  | "contact"
  | "agent"
  | "message"
  | "conversation"
  | "sender"
  | "previousStep"
  | "steps"
  | "trigger";

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
   * inside the step editor; "sender" is the trigger-actor alias (contact
   * for inbound messages, agent for assignments etc.).
   */
  group:
    | "builtin"
    | "custom"
    | "agent"
    | "message"
    | "conversation"
    | "sender";
}

const BUILTIN_CONTACT_TOKENS: TokenSpec[] = [
  { token: "$var.contact.name", label: "Contact name", group: "builtin" },
  { token: "$var.contact.phone", label: "Phone number", group: "builtin" },
  { token: "$var.contact.email", label: "Email", group: "builtin" },
  { token: "$var.contact.location", label: "Location", group: "builtin" },
  // PR 2.4 additions — surface in the picker so authors discover them.
  { token: "$var.contact.window_state", label: "Window state (open/closed/…)", group: "builtin" },
  { token: "$var.contact.stage_name", label: "Lifecycle stage", group: "builtin" },
  { token: "$var.contact.tag_names", label: "Tag names (comma-separated)", group: "builtin" },
];

const AGENT_TOKENS: TokenSpec[] = [
  { token: "$var.agent.name", label: "Agent name", group: "agent" },
  { token: "$var.agent.email", label: "Agent email", group: "agent" },
];

const MESSAGE_TOKENS: TokenSpec[] = [
  { token: "$var.message.body", label: "Message text", group: "message" },
  { token: "$var.message.sender_name", label: "Sender name", group: "message" },
  { token: "$var.message.timestamp", label: "Sent at", group: "message" },
  { token: "$var.message.direction", label: "Direction (in/out)", group: "message" },
  { token: "$var.message.id", label: "Message id", group: "message" },
  { token: "$var.message.external_id", label: "External id (wamid)", group: "message" },
  { token: "$var.message.channel", label: "Channel (e.g. meta_cloud)", group: "message" },
  { token: "$var.message.media_kind", label: "Media kind", group: "message" },
  { token: "$var.message.media_caption", label: "Media caption", group: "message" },
  { token: "$var.message.media_url", label: "Media URL", group: "message" },
  { token: "$var.message.has_media", label: "Has media (true/false)", group: "message" },
];

const CONVERSATION_TOKENS: TokenSpec[] = [
  { token: "$var.conversation.id", label: "Conversation id", group: "conversation" },
  { token: "$var.conversation.status", label: "Status", group: "conversation" },
  { token: "$var.conversation.assigned_user_id", label: "Assigned user id", group: "conversation" },
  { token: "$var.conversation.assigned_agent_name", label: "Assigned agent name", group: "conversation" },
  { token: "$var.conversation.unread_count", label: "Unread count", group: "conversation" },
  { token: "$var.conversation.has_unread", label: "Has unread (true/false)", group: "conversation" },
  { token: "$var.conversation.last_message_at", label: "Last message at", group: "conversation" },
];

// `sender` alias — for message-driven triggers the contact IS the sender,
// so we expose the same shape under the explicit name. The resolver
// resolves these against the contact (then falls back to the agent for
// non-message triggers like `conversation_assigned`).
const SENDER_TOKENS: TokenSpec[] = [
  { token: "$var.sender.name", label: "Sender name", group: "sender" },
  { token: "$var.sender.phone", label: "Sender phone", group: "sender" },
  { token: "$var.sender.email", label: "Sender email", group: "sender" },
];

export interface TokenContextOptions {
  /** Include `$var.agent.*` in pickers and accept it as a "known" token. */
  includeAgent?: boolean;
  /** Include `$var.message.*` — only meaningful for triggers that carry a message. */
  includeMessage?: boolean;
  /** Include `$var.conversation.*` — only for triggers that carry a conversation. */
  includeConversation?: boolean;
  /** Include `$var.sender.*` alias tokens. Useful in workflow editors
   *  whose triggers carry a contact (message_received) or an actor
   *  (conversation_assigned). */
  includeSender?: boolean;
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
  const sender = options.includeSender ? SENDER_TOKENS : [];
  return [
    ...BUILTIN_CONTACT_TOKENS,
    ...customs,
    ...sender,
    ...message,
    ...conversation,
    ...agent,
  ];
}

/**
 * Regex for `$var.<segment>(.<segment>)+`.
 *
 * Two-deep tokens still match (`$var.contact.name`); deeper paths now
 * resolve too — `$var.trigger.contact.name`, `$var.previousStep.body`,
 * `$var.steps.<stepId>.outputField`. The first segment is the namespace;
 * everything after is a path inside that namespace.
 *
 * Segment grammar: starts with a letter/underscore, then alphanumerics +
 * underscores. Allows mixed-case in the path so step ids (cuids like
 * `ckxyz123`) round-trip. Word-boundary on the trailing side keeps
 * adjacent punctuation out; the lookbehind guards against accidental
 * matches inside an existing identifier.
 */
const TOKEN_RE =
  /(?<![A-Za-z0-9_])\$var\.([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\b/g;

/**
 * Extract the fully-qualified tokens present in `text` (e.g.
 * `"$var.contact.name"`, `"$var.agent.email"`). Each unique token appears
 * once. Used by `findUnknownTokens` and consumers that want to know what's
 * referenced.
 */
export function extractFieldTokens(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  // Local regex instance — the module-scope TOKEN_RE has the `g` flag and
  // its `lastIndex` would carry state between calls if we reused it.
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  while ((m = re.exec(text)) !== null) {
    out.add(m[0]);
  }
  return Array.from(out);
}

/**
 * Walk a dotted path inside an arbitrary JSON value. Returns the final
 * value (any type) or undefined when any segment misses. Used by the
 * `$var.previousStep.X` / `$var.steps.<id>.X` resolution path so a step's
 * structured output can be addressed N levels deep without per-shape glue
 * code.
 */
function lookupDeep(value: unknown, segments: readonly string[]): unknown {
  let cur: unknown = value;
  for (const seg of segments) {
    if (cur == null) return undefined;
    if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Stringify whatever lookupDeep returned for a token replacement. */
function stringifyForToken(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
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
  // PR 2.4 fields — all optional. The snapshot builder populates them when
  // the call site supplies the joined data; non-workflow callers (broadcast
  // runner, snippet preview) leave them undefined and the resolver answers
  // empty for the matching tokens.
  lastInboundAt?: string | null;
  windowState?: "open" | "closing-soon" | "closed" | "never";
  stageName?: string | null;
  tagNames?: string[];
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
  channel?: string | null;
  body?: string;
  direction?: "in" | "out";
  timestamp?: string;
  mediaKind?: string | null;
  mediaCaption?: string | null;
  // PR 2.4 additions.
  senderName?: string | null;
  mediaUrl?: string | null;
  hasMedia?: boolean;
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
  // PR 2.4 additions.
  hasUnread?: boolean;
  assignedAgent?: { id: string; name: string; email: string } | null;
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
  /** Per-step structured outputs (`stepId → JSON value`). Drives
   *  `$var.steps.<id>.X` and `$var.previousStep.X` token resolution. */
  stepOutputs?: Record<string, unknown> | null;
  /** Step the runner advanced from to reach the current step. When set,
   *  `$var.previousStep.X` resolves to `stepOutputs[previousStepId][X]`. */
  previousStepId?: string | null;
  /** The contact that TRIGGERED the run (the original message sender), kept
   *  SEPARATE from the `contact` first-arg. A step that sends to a different
   *  target swaps `contact` for that target — but `$var.sender.*` and
   *  `$var.trigger.contact.*` resolve against THIS so the original sender's
   *  info stays reachable (e.g. "forward who messaged us to another number /
   *  a webhook"). Falls back to `contact` when unset, so templates,
   *  broadcasts, and default trigger-contact steps behave exactly as before. */
  triggerContact?: ContactLike | null;
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
  // The regex matches the FULL path after `$var.` as one capture group;
  // resolve walks the segments. Two-deep tokens (`$var.contact.name`) and
  // deeper ones (`$var.trigger.contact.name`, `$var.previousStep.body`)
  // share this path — `resolvePath` decides the right resolver based on
  // the first segment.
  return text.replace(
    /(?<![A-Za-z0-9_])\$var\.([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\b/g,
    (_, fullPath: string) => {
      const segments = fullPath.split(".");
      return resolvePath(segments, contact, extras);
    },
  );
}

/**
 * Dispatch a parsed token path to the right resolver. First segment is
 * the namespace; everything else is the path within.
 *
 * Namespaces:
 *   - contact, agent, message, conversation — legacy 2-deep paths. The
 *     second segment is the field name; resolution matches the original
 *     pre-refactor behavior exactly (no surprise breakages).
 *   - trigger.<sub>.* — trigger-scoped aliases. `trigger.contact.name`
 *     resolves identically to `contact.name`, `trigger.message.body` to
 *     `message.body`, etc. Makes "this came from the triggering event"
 *     explicit in workflow tokens without forcing a rename.
 *   - sender.* — for `message_received` and similar triggers, resolves to
 *     the contact's fields (the contact IS the sender). For
 *     `conversation_assigned` and friends, falls back to the agent. Pure
 *     convenience alias; the workflow author thinks "who sent / acted on
 *     this" rather than "which snapshot was attached."
 *   - previousStep.<path> — `extras.stepOutputs[extras.previousStepId][path]`.
 *     Drives the per-step output flow for downstream branching.
 *   - steps.<stepId>.<path> — addresses ANY prior step's output by id.
 *     Falls back to undefined if the id isn't in stepOutputs (typo or
 *     step hasn't run yet).
 */
function resolvePath(
  segments: string[],
  contact: ContactLike,
  extras: ResolverExtras,
): string {
  if (segments.length === 0) return "";
  const namespace = segments[0]!;
  const rest = segments.slice(1);
  switch (namespace) {
    case "contact":
      return rest.length === 1 ? resolveContact(rest[0]!, contact) : "";
    case "agent":
      return rest.length === 1 ? resolveAgent(rest[0]!, extras.agent ?? null) : "";
    case "message":
      return rest.length === 1
        ? resolveMessage(rest[0]!, extras.message ?? null)
        : "";
    case "conversation":
      return rest.length === 1
        ? resolveConversation(rest[0]!, extras.conversation ?? null)
        : "";
    case "trigger":
      // trigger.contact.<field> → the ORIGINAL trigger sender, independent of
      // the step's send target (which drives the bare `contact` namespace).
      // This is what lets a step that sends to a DIFFERENT customer still
      // reference who triggered the run. Other trigger.<sub> paths
      // (message / conversation) recurse to their already-trigger-scoped
      // extras unchanged.
      if (rest[0] === "contact" && rest.length === 2) {
        return resolveContact(rest[1]!, extras.triggerContact ?? contact);
      }
      return resolvePath(rest, contact, extras);
    case "sender": {
      // Sender alias = the trigger ACTOR. Resolve against the trigger contact
      // (NOT the step's send target), then fall back to the agent for
      // agent-driven triggers (assignment/close). `triggerContact` falls back
      // to `contact` when unset, so non-target callers behave as before. Both
      // shapes expose parallel keys (contact.name vs agent.name).
      if (rest.length !== 1) return "";
      const k = rest[0]!;
      const base = extras.triggerContact ?? contact;
      const fromContact = resolveContact(k, base);
      if (fromContact !== "") return fromContact;
      return resolveAgent(k, extras.agent ?? null);
    }
    case "previousStep": {
      const id = extras.previousStepId;
      if (!id || !extras.stepOutputs) return "";
      const stepValue = extras.stepOutputs[id];
      return stringifyForToken(lookupDeep(stepValue, rest));
    }
    case "steps": {
      // steps.<stepId>.<path...>
      if (rest.length < 1 || !extras.stepOutputs) return "";
      const stepId = rest[0]!;
      const stepValue = extras.stepOutputs[stepId];
      return stringifyForToken(lookupDeep(stepValue, rest.slice(1)));
    }
    default:
      return "";
  }
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
      case "last_inbound_at":
        return contact.lastInboundAt ?? "";
      case "window_state":
        return contact.windowState ?? "";
      case "stage_name":
        return contact.stageName ?? "";
      case "tag_names":
        return (contact.tagNames ?? []).join(", ");
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
    case "channel":
      return message.channel ?? "";
    case "media_kind":
      return message.mediaKind ?? "";
    case "media_caption":
      return message.mediaCaption ?? "";
    case "sender_name":
      return message.senderName ?? "";
    case "media_url":
      return message.mediaUrl ?? "";
    case "has_media":
      return message.hasMedia ? "true" : "false";
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
    case "has_unread":
      return conversation.hasUnread ? "true" : "false";
    case "assigned_agent_name":
      return conversation.assignedAgent?.name ?? "";
    case "assigned_agent_email":
      return conversation.assignedAgent?.email ?? "";
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
  // Helper for the legacy 2-deep namespaces (contact / agent / message /
  // conversation). Returns true iff the key is in the corresponding
  // schema and the namespace itself is opted in by the caller.
  function knownLegacyKey(namespace: string, key: string): boolean {
    if (namespace === "contact") return contactKeys.has(key);
    if (namespace === "agent") return !!agentKeys && agentKeys.has(key);
    if (namespace === "message") return !!messageKeys && messageKeys.has(key);
    if (namespace === "conversation") {
      return !!conversationKeys && conversationKeys.has(key);
    }
    return false;
  }
  const out: string[] = [];
  for (const tok of extractFieldTokens(text)) {
    const segments = tok.slice("$var.".length).split(".");
    if (segments.length < 2) {
      out.push(tok);
      continue;
    }
    const ns = segments[0]!;
    // Legacy 2-deep paths: <namespace>.<key>
    if (
      (ns === "contact" || ns === "agent" || ns === "message" || ns === "conversation") &&
      segments.length === 2
    ) {
      if (!knownLegacyKey(ns, segments[1]!)) out.push(tok);
      continue;
    }
    // trigger.<sub>.<key> — same validation as the bare sub-namespace.
    if (ns === "trigger" && segments.length === 3) {
      if (!knownLegacyKey(segments[1]!, segments[2]!)) out.push(tok);
      continue;
    }
    // sender.<key> — accepts any key the contact OR agent namespace has.
    if (ns === "sender" && segments.length === 2) {
      const k = segments[1]!;
      const ok = contactKeys.has(k) || (agentKeys?.has(k) ?? false);
      if (!ok) out.push(tok);
      continue;
    }
    // previousStep.<...> and steps.<id>.<...> can't be statically
    // validated — the step's output shape isn't part of the schema (it's
    // computed at run time). Accept ANY path under them; runtime returns
    // empty for misses, which is the same fail-soft semantics as the
    // legacy namespaces.
    if (ns === "previousStep" && segments.length >= 2) continue;
    if (ns === "steps" && segments.length >= 3) continue;
    out.push(tok);
  }
  return out;
}
