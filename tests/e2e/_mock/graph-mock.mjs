/**
 * Mock Meta Graph API server for the e2e Meta-channels suite.
 *
 * The real app posts every outbound send + connect-time validation to
 * `https://graph.facebook.com`. That host is unreachable on the CI/dev box (and
 * a real send would bill the team + text a real person), so the e2e run points
 * the API at THIS server via `META_GRAPH_BASE_URL=http://127.0.0.1:<port>`.
 *
 * It does two jobs:
 *   1. Answers each Graph call with a Meta-shaped response so the send/validation
 *      code path completes exactly as it would against real Meta.
 *   2. Records every request (method, path, query, parsed body) so a spec can
 *      assert the REAL outbound wire shape — recipient id, messaging_type /
 *      HUMAN_AGENT tag, IG url vs Messenger attachment_id, reply_to fragment.
 *
 * Control endpoints (never part of Graph): `POST /__mock/reset` clears the log,
 * `GET /__mock/calls` returns it. Plain Node http + ESM so it runs under `node`
 * with no build step.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4100);

/** @type {Array<{method:string,path:string,query:Record<string,string>,body:any,authorization:string|undefined,at:number}>} */
let calls = [];
let seq = 0;
/** Fail the next `failSendsRemaining` sends with `failSendStatus`; 0 = normal. */
let failSendsRemaining = 0;
let failSendStatus = 500;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function json(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const raw = await readBody(req);
  let body = null;
  const ct = req.headers["content-type"] ?? "";
  if (raw.length && ct.includes("application/json")) {
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = { __unparsed: raw.toString("utf8").slice(0, 500) };
    }
  } else if (raw.length && ct.includes("multipart/form-data")) {
    // Attachment upload — we don't parse multipart; just note it happened and
    // its size so a spec can assert an upload occurred.
    body = { __multipart: true, bytes: raw.length };
  }

  // ---- Control plane ----------------------------------------------------
  if (path === "/__mock/reset" && method === "POST") {
    // Clear only the recorded calls — NOT `seq`. The message-id counter must
    // stay monotonic across resets so every send gets a globally-unique mid;
    // reusing ids would collide on the app's real (teamId,channel,externalId)
    // dedup and fold two distinct sends into one row.
    calls = [];
    failSendsRemaining = 0;
    return json(res, 200, { ok: true });
  }
  // Arm the next `count` `POST .../messages` calls to fail with `status`. Lets a
  // spec drive the AMBIGUOUS send path (Meta 5xx — the message may or may not
  // have landed), the only way to exercise the OUTBOUND-1 invariant: the
  // idempotency claim must be RETAINED so a same-key retry can't re-send a
  // possibly-delivered, billed message.
  //
  // `count` (not one-shot) because the provider RETRIES a transient 5xx
  // internally — a single injected failure is swallowed and the send succeeds.
  // Arm more than the provider's retry budget to make the failure terminal.
  // Cleared by /__mock/reset.
  if (path === "/__mock/fail-next-send" && method === "POST") {
    failSendStatus = Number(body?.status) || 500;
    failSendsRemaining = Number(body?.count) || 1;
    return json(res, 200, { ok: true, status: failSendStatus, count: failSendsRemaining });
  }
  if (path === "/__mock/calls" && method === "GET") {
    return json(res, 200, { calls });
  }
  if (path === "/__mock/health" && method === "GET") {
    return json(res, 200, { ok: true });
  }

  // ---- Record every Graph call ------------------------------------------
  const query = Object.fromEntries(url.searchParams.entries());
  calls.push({
    method,
    path,
    query,
    body,
    authorization: req.headers["authorization"],
    at: Date.now(),
  });

  const n = ++seq;
  const segments = path.split("/").filter(Boolean); // [version, id, sub?]
  const last = segments[segments.length - 1];

  // GET /{v}/me?fields=id  → system-user token validation (Meta App connect)
  if (method === "GET" && last === "me") {
    return json(res, 200, { id: `mockapp_${n}` });
  }

  // POST /{v}/{id}/messages  → the send. WhatsApp and social share the path;
  // disambiguate on messaging_product (WhatsApp sets it, social never does).
  if (method === "POST" && last === "messages") {
    if (failSendsRemaining > 0) {
      failSendsRemaining -= 1;
      return json(res, failSendStatus, {
        error: { message: "Mock: injected send failure", code: 2, type: "OAuthException" },
      });
    }
    if (body && body.messaging_product === "whatsapp") {
      return json(res, 200, {
        messaging_product: "whatsapp",
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.MOCK.${n}` }],
      });
    }
    return json(res, 200, {
      recipient_id: body?.recipient?.id ?? "unknown",
      message_id: `mid.MOCK.${n}`,
    });
  }

  // POST /{v}/{id}/message_attachments  → Messenger reusable attachment upload
  if (method === "POST" && last === "message_attachments") {
    return json(res, 200, { attachment_id: `att_${n}` });
  }

  // POST /{v}/{page-id}/calls  → Messenger Calling unified action endpoint.
  if (method === "POST" && last === "calls") {
    const action = body?.action;
    if (action === "connect") {
      // Outbound: returns a new call id + the SDP answer synchronously.
      return json(res, 200, {
        success: true,
        id: `c_MOCK_${n}`,
        session: { sdp_response: { sdp_type: "answer", sdp: `MOCK_ANSWER_${n}` } },
      });
    }
    if (action === "accept") {
      // Inbound accept: we send our offer, Meta returns answer + renegotiation.
      return json(res, 200, {
        success: true,
        session: {
          sdp_response: { sdp_type: "answer", sdp: `MOCK_ANSWER_${n}` },
          sdp_renegotiation: { sdp_type: "offer", sdp: `MOCK_RENEG_${n}` },
        },
      });
    }
    // reject | terminate | media_update
    return json(res, 200, { success: true });
  }

  // POST /{v}/{page-id}/business_messaging_feature_status  → calling eligibility
  if (method === "POST" && last === "business_messaging_feature_status") {
    const feature = body?.features?.[0]?.feature ?? "messenger_api_calling";
    return json(res, 200, { data: [{ feature, status: "enabled" }] });
  }

  // GET /{v}/{page-id}/messenger_call_permissions?psid=  → outbound-call permission
  if (method === "GET" && last === "messenger_call_permissions") {
    return json(res, 200, {
      permission: { status: "has_permission", expiration_time: 1900000000 },
      actions: [
        { action_name: "send_call_permission_request", can_perform: true, limits: [{ time_period: "PT24H", max_allowed: 2, current_usage: 0 }] },
        { action_name: "start_call", can_perform: true },
      ],
    });
  }

  // POST /{v}/{id}/media  → WhatsApp media upload
  if (method === "POST" && last === "media") {
    return json(res, 200, { id: `media_${n}` });
  }

  // GET /{v}/{pageOrIgId}?fields=name,access_token → page validation + Page
  // access-token derivation (Messenger / Instagram connect).
  if (method === "GET" && (query.fields ?? "").includes("access_token")) {
    return json(res, 200, {
      id: segments[1] ?? `obj_${n}`,
      name: "Mock Page",
      access_token: `PAGE_TOKEN_${segments[1] ?? n}`,
    });
  }

  // Any other GET (best-effort profile/name lookups) → benign shape.
  if (method === "GET") {
    return json(res, 200, { id: segments[1] ?? `obj_${n}`, name: "Mock Object" });
  }

  // Fallback: accept + record so an unexpected call is visible, not a hang.
  return json(res, 200, { ok: true, mock: true });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[graph-mock] listening on http://127.0.0.1:${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
