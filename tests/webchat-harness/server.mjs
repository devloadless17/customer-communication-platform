/**
 * Mock backend for the webchat widget, so the REAL (minified) widget can be
 * driven end to end without the app, a database or Meta.
 *
 * It speaks the actual `/widget` socket protocol the gateway implements —
 * `ready`, `history`, `message`, `message:status`, `typing`, `agents`,
 * `conversation:status` — plus a `/__ctl` control plane the tests use to seed
 * state, inject frames and inspect what the widget sent.
 *
 * Lives in the repo deliberately: an earlier copy under /tmp was wiped by a
 * tmp sweep, taking every assertion with it.
 *
 *   node tests/webchat-harness/server.mjs          # serves widget.js
 *   WIDGET_MIN=1 node tests/webchat-harness/server.mjs   # serves widget.min.js
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../../apps/web/public");
const PORT = Number(process.env.PORT || 8124);
// socket.io is apps/api's dependency, not this folder's — resolve it from there
// so the harness needs no package.json of its own.
const require_ = createRequire(import.meta.url);
const { Server } = require_(require_.resolve("socket.io", { paths: [resolve(HERE, "../../apps/api")] }));
const WIDGET_FILE = process.env.WIDGET_MIN ? "widget.min.js" : "widget.js";

/** Everything a test can seed or inspect. */
const state = {
  config: { theme: { primaryColor: "#16a34a" }, headerTitle: "Harness" },
  history: [],
  hasMore: false,
  olderPages: [],
  received: [],      // visitor:message payloads the widget sent
  presenceSeen: [],  // visitor:presence frames
  agentsOnline: true,
  ackMode: "ok",     // ok | error | rate_limited | silent
  handshakeError: null,
  holdHistoryMs: 0,  // delay the history frame (exercises loading states)
  visitorId: null,   // whose thread `history` currently represents
};

const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Customer website</title>
<style>body{font-family:system-ui;padding:28px;background:#f4f5f7;color:#111827}</style></head>
<body><h1>Customer website</h1><p>Some page content.</p>
<script src="/${WIDGET_FILE}" data-webchat-key="wc_pk_harness" defer></script></body></html>`;

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__ctl") {
    let body = "";
    for await (const c of req) body += c;
    const cmd = body ? JSON.parse(body) : {};
    if (cmd.set) {
      Object.assign(state, cmd.set);
      // A seeded history belongs to whoever connects next, or the rotation wipe
      // below would erase the fixture the test just planted.
      if (Object.prototype.hasOwnProperty.call(cmd.set, "history")) state.visitorId = null;
    }
    if (cmd.agentMessage && live) {
      const m = { id: "srv" + Date.now(), externalId: "se" + Date.now(), direction: "out", body: cmd.agentMessage.body,
        senderName: cmd.agentMessage.senderName, status: "sent", createdAt: new Date().toISOString() };
      state.history.push(m); live.emit("message", m);
    }
    if (cmd.emit && live) live.emit(cmd.emit.event, cmd.emit.data);
    if (cmd.disconnect && live) live.disconnect(true);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, state }));
  }
  if (url.pathname === "/host.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(HOST_HTML);
  }
  if (url.pathname === "/api/widget/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ widgetId: "w1", name: "Harness", config: state.config }));
  }
  if (url.pathname === `/${WIDGET_FILE}` || url.pathname === "/webchat/socket.io.min.js") {
    const file = url.pathname === `/${WIDGET_FILE}`
      ? resolve(PUBLIC, WIDGET_FILE)
      : resolve(PUBLIC, "webchat/socket.io.min.js");
    try {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(await readFile(file));
    } catch { res.writeHead(404); return res.end("not found"); }
  }
  res.writeHead(404); res.end("not found");
});

let live = null;
const io = new Server(http, { path: "/api/socket", cors: { origin: true } });
const widget = io.of("/widget");
widget.use((socket, next) => {
  if (state.handshakeError) return next(new Error(state.handshakeError));
  next();
});
widget.on("connection", (socket) => {
  live = socket;
  // The real gateway resolves history from the CONTACT behind the visitorId, so a
  // rotated identity sees an empty thread. Mirror that.
  const vid = socket.handshake.auth && socket.handshake.auth.visitorId;
  if (state.visitorId && vid && vid !== state.visitorId) { state.history = []; state.received = []; }
  state.visitorId = vid || state.visitorId;

  socket.emit("ready", { widgetId: "w1", name: "Harness", config: state.config });
  socket.emit("agents", { online: state.agentsOnline });
  const sendHistory = () => socket.emit("history", { messages: state.history, hasMore: state.hasMore });
  if (state.holdHistoryMs > 0) setTimeout(sendHistory, state.holdHistoryMs);
  else sendHistory();

  socket.on("visitor:message", (payload, ack) => {
    state.received.push(payload);
    if (state.ackMode === "silent") return;
    if (state.ackMode === "rate_limited") { if (ack) ack({ ok: false, error: "rate_limited" }); return; }
    if (state.ackMode === "error") { if (ack) ack({ ok: false, error: "failed" }); return; }
    const m = { id: "m" + state.received.length, externalId: "widget:v:" + payload.clientMsgId,
      direction: "in", body: payload.body, status: "sent", createdAt: new Date().toISOString(),
      replyTo: payload.replyToExternalId ? { id: null, body: "" } : null };
    state.history.push(m);
    if (ack) ack({ ok: true, id: m.id });
    socket.emit("message", m);
  });
  socket.on("visitor:loadOlder", (_b, ack) => {
    const page = state.olderPages.shift();
    if (ack) ack({ messages: (page && page.messages) || [], hasMore: state.olderPages.length > 0 });
  });
  socket.on("visitor:presence", (p) => state.presenceSeen.push(p));
  socket.on("visitor:typing", () => {});
  socket.on("visitor:read", () => {});
  socket.on("visitor:received", () => {});
});

http.listen(PORT, () => console.log(`[harness] http://localhost:${PORT}/host.html (${WIDGET_FILE})`));
