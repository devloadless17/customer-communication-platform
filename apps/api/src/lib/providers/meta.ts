import type { MetaSendConfig } from "@/lib/providers/config";
import type {
  CreateTemplateArgs,
  CreateTemplateResult,
  DeleteTemplateArgs,
  FetchedMedia,
  MessagingProvider,
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedMediaRef,
  NormalizedStatusUpdate,
  ProviderTemplate,
  SendMediaArgs,
  SendTemplateArgs,
  SendTextArgs,
  SendTextResult,
  TemplateCategory,
  TemplateComponent,
  TemplateStatus,
  UploadHeaderMediaArgs,
  UploadHeaderMediaResult,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import type { MediaKind, MessageStatus } from "@ccp/shared/types";

/**
 * Meta WhatsApp Cloud API webhook parser.
 *
 * Payload shape (abridged):
 *   { object, entry: [{ id, changes: [{ field, value: { messages?, statuses?, contacts?, metadata } }] }] }
 *
 * Walks `entry[].changes[].value` and emits one NormalizedInboundMessage per
 * incoming text message. Statuses are dropped at parse time for now (logged
 * at the route).
 *
 * Send / read calls take a MetaSendConfig (phone_number_id + access token)
 * loaded from the Team row by the route handler — the provider itself reads
 * no env vars. CLAUDE.md rule #6.
 */

/**
 * `fetch` with a hard timeout. Every Meta Graph / CDN call goes through here
 * so a hung upstream can't stall the request that triggered it — most
 * importantly the webhook handler, which downloads inbound media synchronously
 * before it returns 200 to Meta. Without this, one slow CDN response makes
 * Meta time the webhook out and retry the whole batch.
 */
const META_FETCH_TIMEOUT_MS = Number(process.env.META_FETCH_TIMEOUT_MS ?? 20_000);
const META_FETCH_MAX_ATTEMPTS = 2; // 1 retry on transient 5xx

async function metaFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  // Retry policy: transient 5xx + network errors get one quick retry. We
  // intentionally do NOT retry 4xx — those are policy errors (24h-window
  // closed, template missing, bad auth) where retrying just hides the real
  // problem. Without this, a Meta 503 blip surfaces as a "send failed"
  // bubble the agent has to manually click Retry on. With a single 500ms
  // retry, the vast majority of Meta's transient blips never reach the UI.
  let lastErr: unknown;
  for (let attempt = 0; attempt < META_FETCH_MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), META_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(input, { ...init, signal: ac.signal });
      // 5xx is transient by Meta convention. Retry once with backoff. The
      // request body is whatever the caller passed in `init.body` — fetch
      // re-uses it on retry without re-streaming concerns because all our
      // bodies are buffered (JSON or FormData built from in-memory bytes).
      if (res.status >= 500 && res.status < 600 && attempt < META_FETCH_MAX_ATTEMPTS - 1) {
        // Drain so the connection can be reused by the keepalive pool.
        await res.text().catch(() => {});
        await sleep(500 + Math.random() * 250);
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Timeouts surface as a typed error after the last attempt; mid-loop
        // we treat them as retryable network blips.
        lastErr = new Error(
          `meta request timed out after ${META_FETCH_TIMEOUT_MS}ms: ${input}`,
        );
      } else {
        lastErr = err;
      }
      if (attempt < META_FETCH_MAX_ATTEMPTS - 1) {
        await sleep(500 + Math.random() * 250);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable — loop returns or throws above.
  throw lastErr ?? new Error("metaFetch: no attempts ran");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface MetaEnvelope {
  object?: string;
  entry?: MetaEntry[];
}

interface MetaEntry {
  id?: string;
  changes?: MetaChange[];
}

interface MetaChange {
  field?: string;
  value?: MetaChangeValue;
}

interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
}

interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}

interface MetaMediaPayload {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  // audio voice notes carry voice=true; we treat both as "audio"
  voice?: boolean;
  // not all media types include a duration but some do
  duration?: number;
}

interface MetaContextRef {
  // Wamid of the message this one is replying to.
  id?: string;
  // The wa_id of the original sender (kept for debugging only).
  from?: string;
}

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMediaPayload;
  video?: MetaMediaPayload;
  audio?: MetaMediaPayload;
  document?: MetaMediaPayload;
  sticker?: MetaMediaPayload;
  context?: MetaContextRef;
}

const META_MEDIA_TYPES: MediaKind[] = ["image", "video", "audio", "document", "sticker"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function mapMetaStatus(s: string | undefined): MessageStatus | null {
  switch (s) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export const metaProvider: MessagingProvider<MetaSendConfig> = {
  name: "meta_cloud",

  capabilities: {
    // WhatsApp's customer-service window: 24h since last inbound. Outside
    // it, only pre-approved templates can be sent.
    freeFormWindowMs: 24 * 60 * 60 * 1000,
    templates: true,
    readReceipts: true,
    typingIndicators: true,
  },

  parseWebhook(payload: unknown): NormalizedEvent[] {
    if (!isObject(payload)) return [];
    const env = payload as MetaEnvelope;
    if (env.object !== "whatsapp_business_account") return [];

    const events: NormalizedEvent[] = [];

    for (const entry of env.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        if (!value) continue;

        // Build a quick wa_id → name lookup from the contacts array.
        const nameByWaId = new Map<string, string>();
        for (const c of value.contacts ?? []) {
          if (c.wa_id && c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
        }

        for (const m of value.messages ?? []) {
          const externalId = m.id;
          // Meta's wa_id is digits-only by spec, but we strip non-digits
          // defensively. The DB stores digits-only too (lib/phone.ts) so the
          // contact lookup will hit on the inbound's first reply.
          const phone = m.from ? m.from.replace(/\D/g, "") : undefined;
          if (!externalId || !phone) continue;

          const tsSecs = m.timestamp ? Number(m.timestamp) : NaN;
          const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();

          // Pre-extract the optional reply context so both text + media branches
          // share the same shape. Meta sends `context.id` as the wamid of the
          // original; we round-trip the wamid and let ingest resolve to our id.
          const replyToExternalId = m.context?.id;

          if (m.type === "text") {
            const body = m.text?.body;
            if (!body) continue;
            events.push({
              kind: "message",
              externalId,
              contactPhone: phone,
              contactName: nameByWaId.get(phone) ?? null,
              body,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }

          // Media: image / video / audio / document / sticker. Each has its
          // own subobject with id, mime_type, optional caption + filename.
          const mediaKind = m.type as MediaKind | undefined;
          if (!mediaKind || !META_MEDIA_TYPES.includes(mediaKind)) continue;
          const mediaPayload = m[mediaKind] as MetaMediaPayload | undefined;
          if (!mediaPayload?.id || !mediaPayload.mime_type) continue;

          const media: NormalizedMediaRef = {
            kind: mediaKind,
            externalMediaId: mediaPayload.id,
            mimeType: mediaPayload.mime_type,
            ...(mediaPayload.filename ? { filename: mediaPayload.filename } : {}),
            ...(mediaPayload.duration
              ? { durationMs: mediaPayload.duration * 1000 }
              : {}),
          };

          events.push({
            kind: "message",
            externalId,
            contactPhone: phone,
            contactName: nameByWaId.get(phone) ?? null,
            // Caption goes into body so search + previews stay uniform.
            body: mediaPayload.caption ?? "",
            media,
            timestamp: ts,
            rawPayload: payload as Record<string, unknown>,
            ...(replyToExternalId ? { replyToExternalId } : {}),
          } satisfies NormalizedInboundMessage);
        }

        for (const s of value.statuses ?? []) {
          const status = mapMetaStatus(s.status);
          if (!status || !s.id) continue;
          const tsSecs = s.timestamp ? Number(s.timestamp) : NaN;
          const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();
          const evt: NormalizedStatusUpdate = {
            kind: "status",
            externalId: s.id,
            status,
            timestamp: ts,
            rawPayload: payload as Record<string, unknown>,
          };
          events.push(evt);
        }
      }
    }

    return events;
  },

  async sendText(args: SendTextArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "text",
        text: { body: args.body },
        // When replying, include `context` so the customer's WhatsApp shows
        // the quote + jump-to-original behavior. Meta validates the wamid
        // is recent enough; a stale wamid returns error 131xxx.
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      }),
    });

    if (!res.ok) {
      // Surface Meta's error body so 24h-window failures (code 131047) and
      // similar policy errors land in our logs verbatim. Caller decides how
      // to render this to the agent.
      const text = await res.text();
      throw new MetaSendError(`meta sendText failed: ${res.status} ${text}`, res.status, text);
    }

    const json = (await res.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendText response missing message id: ${JSON.stringify(json)}`);
    }

    // Meta's response doesn't include a server timestamp; we stamp at send.
    return { externalId, timestamp: new Date() };
  },

  async sendTypingIndicator(externalId: string, config: MetaSendConfig): Promise<void> {
    // Meta bundles the typing bubble onto the read-receipt endpoint: the call
    // marks `externalId` as read AND shows the customer a typing indicator
    // for up to 25 seconds. The indicator auto-dismisses when the next
    // outbound message lands or the timer expires — there is no explicit
    // "stop typing" endpoint. Caller is responsible for refreshing every
    // ~20s while the agent keeps typing.
    //
    // Constraint: requires a recent inbound to anchor on. Outside the 24h
    // window (no recent inbound), Meta rejects with policy errors — we
    // swallow them since the agent's local UX shouldn't degrade.
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: externalId,
        typing_indicator: { type: "text" },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `[meta] sendTypingIndicator failed for ${externalId}: ${res.status} ${body}`,
      );
    }
  },

  async markIncomingRead(externalId: string, config: MetaSendConfig): Promise<void> {
    // Meta's read-receipt endpoint reuses the messages POST shape with
    // status: "read" — marking the latest wamid as read implicitly marks
    // every earlier inbound from that conversation as read on the customer's
    // device, so one call per agent-view is enough.
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: externalId,
      }),
    });

    if (!res.ok) {
      // Non-fatal: log but don't throw. Common cause is a wamid older than
      // the 7-day window Meta accepts for read receipts.
      const body = await res.text();
      console.warn(
        `[meta] markIncomingRead failed for ${externalId}: ${res.status} ${body}`,
      );
    }
  },

  // -------------------------------------------------------------------------
  // Media: fetch (inbound), upload (outbound staging), send (outbound).
  // -------------------------------------------------------------------------

  async fetchMedia(externalMediaId: string, config: MetaSendConfig): Promise<FetchedMedia> {
    // Step 1: GET /{media-id} → { url, mime_type, ... }. The signed URL is
    // valid for ~5 minutes — we MUST hit it immediately. Don't store it.
    const metaUrl = `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(externalMediaId)}`;
    const metaRes = await metaFetch(metaUrl, {
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!metaRes.ok) {
      const t = await metaRes.text();
      throw new MetaSendError(
        `meta media metadata failed: ${metaRes.status} ${t}`,
        metaRes.status,
        t,
      );
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url || !meta.mime_type) {
      throw new Error("meta media metadata missing url or mime_type");
    }

    // Step 2: download the binary. Meta's CDN ALSO requires the bearer token
    // — undocumented gotcha, requests without it 401.
    const binRes = await metaFetch(meta.url, {
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!binRes.ok) {
      const t = await binRes.text().catch(() => "");
      throw new MetaSendError(
        `meta media download failed: ${binRes.status} ${t}`,
        binRes.status,
        t,
      );
    }
    const ab = await binRes.arrayBuffer();
    return { bytes: new Uint8Array(ab), mimeType: meta.mime_type };
  },

  async uploadMedia(
    args: UploadMediaArgs,
    config: MetaSendConfig,
  ): Promise<UploadMediaResult> {
    // Multipart upload to /{phone-number-id}/media. Meta returns an id valid
    // for ~30 days, single-use per outbound message.
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/media`;
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    // Meta requires the type field — using the mime type works. The wire
    // format of the file part is what Meta dispatches the right validators on.
    fd.append("type", args.mimeType);
    // Hand the Uint8Array straight to Blob. Node 20+'s undici-backed Blob
    // accepts Uint8Array as a BlobPart at runtime — the prior `new
    // ArrayBuffer(len) + .set(bytes)` dance doubled peak RAM (one copy of
    // the bytes + the ArrayBuffer + the Blob internal). For a 100MB
    // document upload that doubled-copy was a measurable OOM risk on the
    // 4GB heap. The cast is needed because TS's BlobPart type narrows to
    // `Uint8Array<ArrayBuffer>` (excluding SharedArrayBuffer); our bytes
    // always come from `file.arrayBuffer()` or `fetch().arrayBuffer()`,
    // both of which return ArrayBuffer-backed Uint8Arrays.
    fd.append(
      "file",
      new Blob([args.bytes as Uint8Array<ArrayBuffer>], { type: args.mimeType }),
      args.filename,
    );

    const res = await metaFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.accessToken}` },
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new MetaSendError(
        `meta media upload failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      throw new Error(`meta media upload missing id: ${JSON.stringify(json)}`);
    }
    return { mediaId: json.id };
  },

  async sendMedia(args: SendMediaArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Build the type-specific subobject. Caption is only accepted on
    // image/video/document; sticker + audio reject it (Meta returns 100).
    const sub: Record<string, unknown> = { id: args.mediaId };
    if (args.caption && (args.kind === "image" || args.kind === "video" || args.kind === "document")) {
      sub.caption = args.caption;
    }
    if (args.kind === "document" && args.filename) {
      sub.filename = args.filename;
    }

    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: args.kind,
        [args.kind]: sub,
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new MetaSendError(
        `meta sendMedia failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendMedia response missing id: ${JSON.stringify(json)}`);
    }
    return { externalId, timestamp: new Date() };
  },

  // -------------------------------------------------------------------------
  // Templates: list approved templates + send a parameterized one.
  //
  // Meta's templates live at the WhatsApp Business Account level — not the
  // phone number. That's why fetchTemplates requires wabaId in config; if it
  // hasn't been pasted yet we throw a typed error so the route can render a
  // helpful "add your WABA id in settings" message instead of a 500.
  // -------------------------------------------------------------------------

  async fetchTemplates(config: MetaSendConfig): Promise<ProviderTemplate[]> {
    if (!config.wabaId) {
      throw new MissingWabaIdError();
    }

    // Page through the catalog. Meta's default page size is 25; we crank it
    // up because most teams have <100 templates total and one round-trip is
    // strictly better than three.
    const url = new URL(
      `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`,
    );
    url.searchParams.set("fields", "name,language,status,category,components,id");
    url.searchParams.set("limit", "200");

    const results: ProviderTemplate[] = [];
    let next: string | null = url.toString();
    // Hard cap on follow-up pages: if a team has > 1000 templates something's
    // wrong upstream, and pagination loops are the easy way to hang a server.
    let pages = 0;

    while (next && pages < 5) {
      pages += 1;
      const res = await metaFetch(next, {
        headers: { authorization: `Bearer ${config.accessToken}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new MetaSendError(
          `meta fetchTemplates failed: ${res.status} ${text}`,
          res.status,
          text,
        );
      }
      const json = (await res.json()) as {
        data?: Array<MetaTemplateRow>;
        paging?: { next?: string };
      };
      for (const row of json.data ?? []) {
        const t = normalizeMetaTemplate(row);
        if (t) results.push(t);
      }
      next = json.paging?.next ?? null;
    }

    return results;
  },

  async createTemplate(
    args: CreateTemplateArgs,
    config: MetaSendConfig,
  ): Promise<CreateTemplateResult> {
    if (!config.wabaId) throw new MissingWabaIdError();

    const url = `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`;
    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        name: args.name,
        language: args.language,
        category: args.category.toUpperCase(),
        components: args.components,
      }),
    });

    if (!res.ok) {
      // Meta's create endpoint is the noisiest one in the API — it rejects
      // for missing examples, duplicate names, policy issues, and per-
      // component validation failures. Surfacing the body verbatim is the
      // only way the UI can show useful error messages.
      const text = await res.text();
      throw new MetaSendError(
        `meta createTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { id?: string; status?: string };
    if (!json.id) {
      throw new Error(`meta createTemplate response missing id: ${JSON.stringify(json)}`);
    }
    const status = mapTemplateStatus(json.status) ?? "pending";
    return { externalId: json.id, status };
  },

  async deleteTemplate(args: DeleteTemplateArgs, config: MetaSendConfig): Promise<void> {
    if (!config.wabaId) throw new MissingWabaIdError();

    // Without `hsm_id`, Meta deletes ALL language variants under `name`.
    // We pass it when we have it so deleting one language leaves the others.
    const url = new URL(
      `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`,
    );
    url.searchParams.set("name", args.name);
    if (args.externalId) url.searchParams.set("hsm_id", args.externalId);

    const res = await metaFetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      // A 404 from Meta means the template is already gone — treat as success
      // so a stale local row that we're cleaning up doesn't keep failing.
      if (res.status === 404) return;
      throw new MetaSendError(
        `meta deleteTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async uploadHeaderMedia(
    args: UploadHeaderMediaArgs,
    config: MetaSendConfig,
  ): Promise<UploadHeaderMediaResult> {
    if (!config.appId) {
      throw new MissingAppIdError();
    }

    // Step 1: create a resumable upload session. Endpoint is app-scoped, not
    // WABA-scoped — different from the per-message media upload.
    const startUrl = new URL(
      `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.appId)}/uploads`,
    );
    startUrl.searchParams.set("file_length", String(args.bytes.byteLength));
    startUrl.searchParams.set("file_type", args.mimeType);
    startUrl.searchParams.set("file_name", args.filename);
    startUrl.searchParams.set("access_token", config.accessToken);

    const startRes = await metaFetch(startUrl, { method: "POST" });
    if (!startRes.ok) {
      const text = await startRes.text();
      throw new MetaSendError(
        `meta upload session failed: ${startRes.status} ${text}`,
        startRes.status,
        text,
      );
    }
    const startJson = (await startRes.json()) as { id?: string };
    const sessionId = startJson.id;
    if (!sessionId) {
      throw new Error(`meta upload session missing id: ${JSON.stringify(startJson)}`);
    }

    // Step 2: POST the bytes to the session. The Authorization header uses
    // `OAuth <token>` (not Bearer) for this endpoint — undocumented for a
    // long time, called out only in the resumable-upload guide.
    const uploadUrl = `https://graph.facebook.com/${config.graphVersion}/${sessionId}`;
    const ab = new ArrayBuffer(args.bytes.byteLength);
    new Uint8Array(ab).set(args.bytes);
    const uploadRes = await metaFetch(uploadUrl, {
      method: "POST",
      headers: {
        authorization: `OAuth ${config.accessToken}`,
        file_offset: "0",
      },
      body: ab,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new MetaSendError(
        `meta upload bytes failed: ${uploadRes.status} ${text}`,
        uploadRes.status,
        text,
      );
    }
    const uploadJson = (await uploadRes.json()) as { h?: string };
    if (!uploadJson.h) {
      throw new Error(`meta upload missing handle: ${JSON.stringify(uploadJson)}`);
    }
    return { headerHandle: uploadJson.h };
  },

  async sendTemplate(
    args: SendTemplateArgs,
    config: MetaSendConfig,
  ): Promise<SendTextResult> {
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;

    // Build the `components` array Meta expects. Each parameterized component
    // becomes one entry with `type` ("header" | "body" | "button") and a
    // `parameters` array of `{ type: "text", text }`. Empty arrays are omitted
    // entirely — sending an empty `parameters` triggers Meta error 132000.
    const components: Array<Record<string, unknown>> = [];
    if (args.variables.header && args.variables.header.length > 0) {
      components.push({
        type: "header",
        parameters: [{ type: "text", text: args.variables.header }],
      });
    }
    if (args.variables.body.length > 0) {
      components.push({
        type: "body",
        parameters: args.variables.body.map((text) => ({ type: "text", text })),
      });
    }

    const res = await metaFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "template",
        template: {
          name: args.name,
          language: { code: args.language },
          ...(components.length > 0 ? { components } : {}),
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new MetaSendError(
        `meta sendTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(
        `meta sendTemplate response missing message id: ${JSON.stringify(json)}`,
      );
    }
    return { externalId, timestamp: new Date() };
  },
};

export class MetaSendError extends Error {
  readonly httpStatus: number;
  readonly body: string;
  constructor(message: string, httpStatus: number, body: string) {
    super(message);
    this.name = "MetaSendError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

/**
 * Stable error code surfaced to the UI / external API consumers. Substring-
 * matching Meta's free-form `body` string in every callsite was both fragile
 * (one wording change from Meta breaks the match) and inconsistent (only the
 * forward route did it). One translator, used everywhere.
 *
 * `code` is the only thing UI / n8n flows should branch on. `message` is a
 * one-liner safe to show as the toast. `detail` is the raw Meta body for the
 * dev console.
 *
 * Meta error reference: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export type MetaErrorCode =
  | "outside_24h_window"   // 131047 — recipient hasn't messaged in 24h; templates only
  | "invalid_recipient"    // 131026/131051 — number invalid or not on WhatsApp
  | "rate_limited"         // 4 / 80007 — Meta rate limit hit
  | "auth_expired"         // 190 — access token expired
  | "unsupported_message"  // 131009 — content type not supported on this account
  | "provider_rejected";   // catch-all for anything else MetaSendError-shaped

export interface NormalizedSendError {
  code: MetaErrorCode;
  /** UI-safe one-liner. */
  message: string;
  /** Raw Meta body (truncated). For logs / dev console. */
  detail: string;
  /** Original HTTP status from Meta. */
  httpStatus: number;
}

/**
 * Translate a thrown `MetaSendError` into the normalized shape above. The
 * detection uses Meta's numeric error code first, then a few well-known
 * substring fallbacks for cases where the body shape varies. Order matters:
 * the first match wins.
 *
 * Returns `null` for non-Meta errors so callers can keep their own catch-all
 * 502 path.
 */
export function normalizeMetaSendError(err: unknown): NormalizedSendError | null {
  if (!(err instanceof MetaSendError)) return null;
  const body = err.body;
  const httpStatus = err.httpStatus;
  const detail = body.slice(0, 500);

  // Parse Meta's numeric error code if present. Body is usually JSON like
  // `{"error":{"code":131047,"message":"...","error_subcode":...}}`. We try
  // JSON first and fall back to a regex so a non-JSON body still hits.
  const numericCode = extractMetaErrorCode(body);

  if (numericCode === 131047 || /131047|re-engagement|24 hours/i.test(body)) {
    return {
      code: "outside_24h_window",
      message: "24-hour window closed — send an approved template to re-engage.",
      detail,
      httpStatus,
    };
  }
  if (numericCode === 131026 || numericCode === 131051) {
    return {
      code: "invalid_recipient",
      message: "Recipient number isn't valid or isn't on WhatsApp.",
      detail,
      httpStatus,
    };
  }
  if (numericCode === 4 || numericCode === 80007) {
    return {
      code: "rate_limited",
      message: "WhatsApp is rate-limiting this number — slow down or wait.",
      detail,
      httpStatus,
    };
  }
  if (numericCode === 190) {
    return {
      code: "auth_expired",
      message: "WhatsApp access token expired — reconnect the number in Settings.",
      detail,
      httpStatus,
    };
  }
  if (numericCode === 131009) {
    return {
      code: "unsupported_message",
      message: "This message type isn't supported on this WhatsApp number.",
      detail,
      httpStatus,
    };
  }
  return {
    code: "provider_rejected",
    message: `WhatsApp rejected the send: ${detail.slice(0, 160)}`,
    detail,
    httpStatus,
  };
}

function extractMetaErrorCode(body: string): number | null {
  try {
    const json = JSON.parse(body) as { error?: { code?: unknown } };
    if (typeof json.error?.code === "number") return json.error.code;
  } catch {
    // Not JSON — fall through to regex.
  }
  const m = body.match(/"code"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Thrown by fetchTemplates when the team hasn't pasted a WABA id yet. The
 * templates route catches this and returns a 409 + actionable message
 * pointing the admin at /settings/whatsapp.
 */
export class MissingWabaIdError extends Error {
  constructor() {
    super("WhatsApp Business Account id is not configured for this team");
    this.name = "MissingWabaIdError";
  }
}

/**
 * Thrown by `uploadHeaderMedia` when the team hasn't pasted a Meta App ID
 * yet. The /templates create route catches this and asks the admin to add it
 * in /settings/whatsapp — same pattern as MissingWabaIdError.
 */
export class MissingAppIdError extends Error {
  constructor() {
    super("Meta App ID is not configured for this team");
    this.name = "MissingAppIdError";
  }
}

// ---------------------------------------------------------------------------
// Template helpers — keep wire-shape parsing local to this file so the
// provider interface stays Meta-agnostic.
// ---------------------------------------------------------------------------

interface MetaTemplateRow {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: TemplateComponent[];
}

function normalizeMetaTemplate(row: MetaTemplateRow): ProviderTemplate | null {
  if (!row.name || !row.language) return null;
  const status = mapTemplateStatus(row.status);
  const category = mapTemplateCategory(row.category);
  if (!status || !category) return null;
  const components = Array.isArray(row.components) ? row.components : [];
  const body = components.find((c) => c.type === "BODY");
  return {
    name: row.name,
    language: row.language,
    status,
    category,
    bodyText: body?.text ?? "",
    components,
    ...(row.id ? { externalId: row.id } : {}),
  };
}

function mapTemplateStatus(s: string | undefined): TemplateStatus | null {
  switch ((s ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION":
      return "pending";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
    case "DELETED":
      return "disabled";
    default:
      return null;
  }
}

function mapTemplateCategory(c: string | undefined): TemplateCategory | null {
  switch ((c ?? "").toUpperCase()) {
    case "MARKETING":
      return "marketing";
    case "UTILITY":
    case "TRANSACTIONAL":
      return "utility";
    case "AUTHENTICATION":
      return "authentication";
    default:
      return null;
  }
}

/**
 * Counts the highest `{{n}}` placeholder in a template body. Used by the UI
 * picker and the send route to figure out how many variables an agent needs
 * to fill in. Doesn't care about gaps — `"Hi {{1}}, see {{3}}"` returns 3,
 * matching Meta's own rule (you must supply 1..N consecutively).
 */
export function countTemplatePlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Renders a preview string by replacing `{{n}}` with the provided values.
 * Missing positions are left as `{{n}}` so the agent can spot which one
 * they forgot before sending.
 */
export function renderTemplateBody(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_match, idxStr) => {
    const idx = Number(idxStr) - 1;
    const v = vars[idx];
    return v && v.length > 0 ? v : `{{${idxStr}}}`;
  });
}

// ---------------------------------------------------------------------------
// Webhook adapter
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  ProviderWebhookSecrets,
  WebhookProvider,
} from "@/lib/providers/webhook";

/**
 * Meta-specific implementation of WebhookProvider. Shares the parser with
 * the MessagingProvider half (`metaProvider.parseWebhook`) — the two halves
 * are the same logical adapter, just split along verify/parse vs. send.
 *
 * GET handshake echoes `hub.challenge` only when the request carries the
 * team's verify token. POST validates the HMAC-SHA256 in
 * `X-Hub-Signature-256` against the team's app secret, using the raw body
 * bytes (Next.js's `req.text()` preserves them; calling `.json()` would
 * re-serialize and invalidate the comparison).
 */
export const metaWebhookProvider: WebhookProvider = {
  name: "meta_cloud",

  verifyChallenge({ url, secrets }) {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode !== "subscribe" || !challenge) return null;
    if (!secrets.verifyToken || token !== secrets.verifyToken) return null;
    return challenge;
  },

  verifyPost({ rawBody, headers, secrets }) {
    if (!secrets.appSecret) return false;
    const header = headers.get("x-hub-signature-256");
    if (!header) return false;
    const expected =
      "sha256=" + createHmac("sha256", secrets.appSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },

  parse(payload) {
    return metaProvider.parseWebhook(payload);
  },
};
