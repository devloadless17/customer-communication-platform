/* Website chat widget — first-party embeddable live chat.
   Embed on any site with ONE classic <script> tag:

     <script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..." defer></script>

   - Renders a launcher + panel inside a Shadow DOM (isolated from the host page).
   - Connects to the "/widget" Socket.io namespace over WebSocket (site-key auth),
     so visitor messages land in the shared inbox and agent/automation replies
     appear here live.
   - Supports text, image / video / audio (incl. voice) / document messages both
     ways, quoted replies, and an optional pre-chat form. No reactions.
   Classic script (not a module) so it loads cross-origin with no CORS; it injects
   socket.io's UMD client from the same origin. */
(function () {
  "use strict";

  var script =
    document.currentScript || document.querySelector("script[data-webchat-key]");
  if (!script) return;
  var siteKey = script.getAttribute("data-webchat-key");
  if (!siteKey) {
    console.error("[webchat] data-webchat-key attribute is missing");
    return;
  }
  var apiBase, staticBase;
  try {
    // staticBase = where widget.js + the socket.io vendor file live (the script's
    // own origin). apiBase = where /api/widget + the "/widget" socket namespace
    // live — the SAME origin in prod (Caddy fronts web + api), but overridable via
    // `data-webchat-api` for a CDN-hosted widget or the dev split (web=:3000,
    // api=:4000).
    staticBase = new URL(script.src).origin;
    apiBase = ((script.getAttribute("data-webchat-api") || "").trim() || staticBase).replace(/\/$/, "");
  } catch (e) {
    console.error("[webchat] cannot resolve widget origin", e);
    return;
  }
  if (document.getElementById("ccp-webchat-root")) return; // already loaded

  var BRAND = "#4f46e5";
  var LS_VISITOR = "ccp_webchat_visitor_" + siteKey;

  function readLS(k) {
    try {
      return localStorage.getItem(k);
    } catch (_e) {
      return null;
    }
  }
  function writeLS(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (_e) {
      /* private mode */
    }
  }

  var state = {
    socket: null,
    open: false,
    ready: false,
    formDone: false,
    sending: false,
    cfg: null, // { name, config: { theme, welcomeMessage, headerTitle, suggestedQuestions, preChatFields, showBranding } }
    preChat: null, // captured responses { name, email, phone } for the first send
    replyTo: null, // { externalId, body } quoted-reply context
    byId: {}, // messageId -> row element
    pending: {}, // clientMsgId -> optimistic row element
    visitorId:
      readLS(LS_VISITOR) ||
      "vis_" + Math.random().toString(36).slice(2) + Date.now().toString(36),
  };
  writeLS(LS_VISITOR, state.visitorId);

  // ---- tiny DOM helper -----------------------------------------------------
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props)
      for (var k in props) {
        if (k === "class") n.className = props[k];
        else if (k === "style") n.setAttribute("style", props[k]);
        else if (k === "html") n.innerHTML = props[k];
        else if (k.slice(0, 2) === "on" && typeof props[k] === "function")
          n.addEventListener(k.slice(2).toLowerCase(), props[k]);
        else if (props[k] != null) n.setAttribute(k, props[k]);
      }
    if (kids != null)
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c == null) return;
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    return n;
  }
  function sanitizeHex(s) {
    if (typeof s !== "string") return null;
    var v = s.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(v)) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    if (/^#[0-9a-f]{6}$/.test(v)) return v;
    return null;
  }
  function contrastOn(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return "#fff";
    var r = parseInt(hex.slice(1, 3), 16),
      g = parseInt(hex.slice(3, 5), 16),
      b = parseInt(hex.slice(5, 7), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? "#0d1220" : "#fff";
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function timeLabel(iso) {
    var d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function mediaUrl(id, thumb) {
    return (
      apiBase +
      "/api/widget/media/" +
      encodeURIComponent(id) +
      "?key=" +
      encodeURIComponent(siteKey) +
      "&v=" +
      encodeURIComponent(state.visitorId) +
      (thumb ? "&thumb=1" : "")
    );
  }

  // ---- shadow root + styles ------------------------------------------------
  var host = el("div", { id: "ccp-webchat-root" });
  host.style.all = "initial";
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent = [
    ":host,*{box-sizing:border-box}",
    ".root{--c:" +
      BRAND +
      ";--ct:#fff;--lc:" +
      BRAND +
      ";--uc:" +
      BRAND +
      ";--uct:#fff;font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0d1220}",
    ".launcher{position:fixed;right:24px;bottom:24px;z-index:2147483646;width:56px;height:56px;border-radius:9999px;background:var(--lc);color:" +
      "#fff;border:0;cursor:pointer;box-shadow:0 10px 25px -5px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}",
    ".launcher:hover{transform:scale(1.05)}.launcher svg{width:26px;height:26px}",
    ".panel{position:fixed;right:24px;bottom:96px;z-index:2147483647;width:384px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 25px 50px -12px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;border:1px solid #e4e8ef}",
    ".panel.open{display:flex}",
    "header{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--c);color:var(--ct)}",
    ".avatar{width:32px;height:32px;border-radius:9999px;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600}",
    "header .title{flex:1;min-width:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "header .x{background:transparent;border:0;color:inherit;cursor:pointer;opacity:.85;padding:4px;border-radius:4px}header .x:hover{opacity:1;background:rgba(255,255,255,.15)}",
    ".body{flex:1;overflow-y:auto;padding:14px;background:#f4f6fa;display:flex;flex-direction:column;gap:10px}",
    ".row{display:flex;flex-direction:column;max-width:82%}.row.out{align-self:flex-end;align-items:flex-end}.row.in{align-self:flex-start;align-items:flex-start}",
    ".bubble{padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;position:relative}",
    ".row.out .bubble{background:var(--uc);color:var(--uct);border-bottom-right-radius:6px}",
    ".row.in .bubble{background:#fff;color:#0d1220;border:1px solid #e4e8ef;border-bottom-left-radius:6px}",
    ".meta{font-size:10px;color:#5a6b85;margin:2px 4px 0}",
    ".reply-q{border-left:3px solid rgba(0,0,0,.2);padding:2px 8px;margin-bottom:4px;font-size:12px;opacity:.85;max-height:44px;overflow:hidden}",
    ".row.out .reply-q{border-left-color:rgba(255,255,255,.5)}",
    ".media img,.media video{max-width:220px;max-height:220px;border-radius:10px;display:block;cursor:pointer}",
    ".media audio{width:220px}",
    ".doc{display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit;font-size:13px}",
    ".doc .ic{width:28px;height:28px;flex:0 0 auto;border-radius:6px;background:rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center}",
    ".reply-act{opacity:0;font-size:11px;color:#5a6b85;cursor:pointer;margin:0 4px;user-select:none}.row:hover .reply-act{opacity:1}",
    ".pills{display:flex;flex-wrap:wrap;gap:6px}.pill{background:#fff;color:var(--c);border:1px solid #e4e8ef;border-radius:9999px;padding:6px 12px;font-size:13px;cursor:pointer}.pill:hover{background:var(--c);color:var(--ct)}",
    ".typing{display:inline-flex;gap:3px;padding:2px 0}.typing i{width:6px;height:6px;background:#a1a1aa;border-radius:9999px;animation:b 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes b{0%,80%,100%{transform:scale(.6);opacity:.5}40%{transform:scale(1);opacity:1}}",
    ".form{background:#fff;border:1px solid #e4e8ef;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}",
    ".form h3{margin:0;font-size:14px}.form .fld{display:flex;flex-direction:column;gap:4px}.form label{font-size:12px;font-weight:600}.form input{font:inherit;font-size:14px;padding:8px 10px;border:1px solid #e4e8ef;border-radius:8px;outline:none}.form input:focus{border-color:var(--c)}",
    ".err{color:#b91c1c;font-size:12px}",
    ".rc{display:none;align-items:center;gap:8px;padding:6px 12px;background:#eef;border-top:1px solid #e4e8ef;font-size:12px;color:#334}.rc.on{display:flex}.rc .qt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rc button{border:0;background:transparent;cursor:pointer;color:#5a6b85;font-size:14px}",
    ".composer{display:flex;gap:6px;align-items:center;padding:10px 12px;background:#fff;border-top:1px solid #e4e8ef}",
    ".composer input[type=text]{flex:1;padding:10px 12px;border:1px solid #e4e8ef;border-radius:8px;font:inherit;font-size:14px;outline:none}.composer input[type=text]:focus{border-color:var(--c)}",
    ".iconbtn{width:38px;height:38px;flex:0 0 auto;border:0;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:#eef0f4;color:#334}.iconbtn:hover{background:#e4e8ef}",
    ".sendbtn{background:var(--c);color:var(--ct)}.sendbtn:hover{filter:brightness(.95)}.iconbtn svg{width:18px;height:18px}.iconbtn:disabled{opacity:.5;cursor:not-allowed}",
    ".foot{font-size:11px;color:#8792a8;text-align:center;padding:5px}",
  ].join("");
  shadow.appendChild(style);
  var root = el("div", { class: "root" });
  shadow.appendChild(root);

  // Launcher
  var launcher = el("button", { class: "launcher", "aria-label": "Open chat" });
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  root.appendChild(launcher);

  // Panel
  var panel = el("div", { class: "panel" });
  var avatarEl = el("div", { class: "avatar" }, "?");
  var titleEl = el("div", { class: "title" }, "Chat");
  var closeBtn = el("button", { class: "x", "aria-label": "Close" }, "✕");
  panel.appendChild(el("header", null, [avatarEl, titleEl, closeBtn]));
  var bodyEl = el("div", { class: "body", role: "log", "aria-live": "polite" });
  panel.appendChild(bodyEl);
  // reply context bar
  var replyBar = el("div", { class: "rc" });
  var replyQt = el("div", { class: "qt" });
  var replyX = el("button", { "aria-label": "Cancel reply" }, "✕");
  replyBar.appendChild(el("span", null, "Replying:"));
  replyBar.appendChild(replyQt);
  replyBar.appendChild(replyX);
  panel.appendChild(replyBar);
  // composer
  var fileInput = el("input", { type: "file", style: "display:none" });
  var attachBtn = el("button", { class: "iconbtn", "aria-label": "Attach a file", title: "Attach" });
  attachBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  var textInput = el("input", { type: "text", placeholder: "Type a message…", autocomplete: "off" });
  var sendBtn = el("button", { class: "iconbtn sendbtn", "aria-label": "Send" });
  sendBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  var composer = el("div", { class: "composer" }, [attachBtn, textInput, sendBtn, fileInput]);
  panel.appendChild(composer);
  var footEl = el("div", { class: "foot" });
  footEl.style.display = "none";
  panel.appendChild(footEl);
  root.appendChild(panel);

  // ---- behaviour -----------------------------------------------------------
  launcher.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);
  sendBtn.addEventListener("click", onSend);
  textInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      onSend();
    }
  });
  attachBtn.addEventListener("click", function () {
    fileInput.click();
  });
  fileInput.addEventListener("change", onPickFile);
  replyX.addEventListener("click", clearReply);

  function openPanel() {
    state.open = true;
    panel.classList.add("open");
    launcher.style.display = "none";
    if (state.formDone) textInput.focus();
  }
  function closePanel() {
    state.open = false;
    panel.classList.remove("open");
    launcher.style.display = "flex";
  }

  function applyTheme(theme) {
    theme = theme || {};
    var c = sanitizeHex(theme.primaryColor) || BRAND;
    var lc = sanitizeHex(theme.launcherColor) || c;
    var uc = sanitizeHex(theme.userBubbleColor) || c;
    root.style.setProperty("--c", c);
    root.style.setProperty("--ct", contrastOn(c));
    root.style.setProperty("--lc", lc);
    root.style.setProperty("--uc", uc);
    root.style.setProperty("--uct", contrastOn(uc));
  }

  function onReady(payload) {
    state.ready = true;
    state.cfg = payload || {};
    var cfg = (payload && payload.config) || {};
    applyTheme(cfg.theme);
    var name = cfg.headerTitle || (payload && payload.name) || "Chat";
    titleEl.textContent = name;
    avatarEl.textContent = (name.trim()[0] || "C").toUpperCase();
    if (cfg.showBranding !== false) {
      footEl.textContent = "Powered by our team";
      footEl.style.display = "";
    }
    var fields = Array.isArray(cfg.preChatFields) ? cfg.preChatFields : [];
    if (fields.length && !state.formDone && !hasHistory) renderForm(fields);
    else {
      state.formDone = true;
      renderWelcome();
    }
  }

  var hasHistory = false;

  function renderForm(fields) {
    composer.style.display = "none";
    bodyEl.innerHTML = "";
    var card = el("div", { class: "form" });
    card.appendChild(el("h3", null, "Before we start"));
    var inputs = [];
    fields.forEach(function (f) {
      var row = el("div", { class: "fld" });
      var lab = el("label", null, f.label + (f.required ? " *" : ""));
      var inp = el("input", {
        type: f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text",
        placeholder: f.label,
      });
      inp._field = f;
      row.appendChild(lab);
      row.appendChild(inp);
      card.appendChild(row);
      inputs.push(inp);
    });
    var errEl = el("div", { class: "err" });
    errEl.style.display = "none";
    card.appendChild(errEl);
    var start = el("button", { class: "iconbtn sendbtn", style: "width:100%;height:38px" }, "Start chat");
    start.addEventListener("click", function () {
      var pre = {};
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i],
          f = inp._field,
          v = inp.value.trim();
        if (f.required && !v) {
          errEl.textContent = "Please fill all required fields.";
          errEl.style.display = "";
          inp.focus();
          return;
        }
        if (f.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          errEl.textContent = "Please enter a valid email.";
          errEl.style.display = "";
          inp.focus();
          return;
        }
        if (v) pre[f.type === "email" ? "email" : f.type === "phone" ? "phone" : "name"] = v;
      }
      state.preChat = pre;
      state.formDone = true;
      composer.style.display = "flex";
      renderWelcome();
      textInput.focus();
    });
    card.appendChild(start);
    bodyEl.appendChild(card);
    if (inputs[0]) inputs[0].focus();
  }

  function renderWelcome() {
    if (hasHistory) return; // history already populated the thread
    bodyEl.innerHTML = "";
    var cfg = (state.cfg && state.cfg.config) || {};
    if (cfg.welcomeMessage) appendBubble({ direction: "in", body: cfg.welcomeMessage, _local: true });
    var qs = Array.isArray(cfg.suggestedQuestions) ? cfg.suggestedQuestions : [];
    if (qs.length) {
      var pills = el("div", { class: "pills" });
      qs.forEach(function (q) {
        pills.appendChild(
          el("button", { class: "pill", onclick: function () {
            textInput.value = q;
            onSend();
          } }, q),
        );
      });
      bodyEl.appendChild(pills);
    }
  }

  // ---- rendering messages --------------------------------------------------
  function bubbleInner(m) {
    var parts = [];
    if (m.replyTo) {
      var q = m.replyTo.mediaKind ? "📎 " + m.replyTo.mediaKind : m.replyTo.body || "";
      parts.push('<div class="reply-q">' + escapeHtml(q).slice(0, 140) + "</div>");
    }
    if (m.media) parts.push(renderMedia(m));
    if (m.body) parts.push('<div>' + escapeHtml(m.body) + "</div>");
    if (m.deletedAt) return '<div style="opacity:.6;font-style:italic">This message was deleted</div>';
    return parts.join("");
  }
  function renderMedia(m) {
    var url = mediaUrl(m.id, false);
    if (m.media.kind === "image")
      return '<div class="media"><a href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" alt="image" loading="lazy"></a></div>';
    if (m.media.kind === "video")
      return '<div class="media"><video src="' + url + '" controls preload="metadata"' + (m.media.hasThumbnail ? ' poster="' + mediaUrl(m.id, true) + '"' : "") + "></video></div>";
    if (m.media.kind === "audio")
      return '<div class="media"><audio src="' + url + '" controls preload="none"></audio></div>';
    var fn = m.media.filename || (m.media.kind || "file");
    return (
      '<a class="doc" href="' +
      mediaUrl(m.id, false) +
      '&download=1" target="_blank" rel="noopener"><span class="ic">📄</span><span>' +
      escapeHtml(fn) +
      "</span></a>"
    );
  }
  function statusTick(status) {
    if (status === "read") return " ✓✓";
    if (status === "delivered") return " ✓✓";
    if (status === "sent") return " ✓";
    if (status === "failed") return " ⚠";
    return "";
  }
  function appendBubble(m) {
    // From the VISITOR's viewpoint, THEIR OWN messages (server direction "in",
    // i.e. inbound to us) render on the RIGHT; agent/automation messages
    // (direction "out") render on the LEFT.
    var isVisitor = m.direction === "in";
    var row = el("div", { class: "row " + (isVisitor ? "out" : "in") });
    row.appendChild(el("div", { class: "bubble", html: bubbleInner(m) }));
    var meta = el("div", { class: "meta" }, timeLabel(m.createdAt) + (isVisitor ? statusTick(m.status) : ""));
    row.appendChild(meta);
    // Quote-reply affordance on real (non-optimistic) messages that have an id.
    if (!m._local && m.externalId) {
      var act = el("span", { class: "reply-act" }, "Reply");
      act.addEventListener("click", function () {
        setReply(m);
      });
      row.appendChild(act);
    }
    row._meta = meta;
    bodyEl.appendChild(row);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    if (m.id) state.byId[m.id] = row;
    return row;
  }

  function upsertMessage(m) {
    // Reconcile an optimistic bubble: externalId ends with the clientMsgId.
    if (m.externalId) {
      for (var cid in state.pending) {
        if (m.externalId.slice(-cid.length) === cid) {
          var prow = state.pending[cid];
          delete state.pending[cid];
          if (prow && prow.parentNode) prow.parentNode.removeChild(prow);
          break;
        }
      }
    }
    if (m.id && state.byId[m.id]) {
      // already rendered — refresh its content (media ready / edit / delete)
      var existing = state.byId[m.id];
      var b = existing.querySelector(".bubble");
      if (b) b.innerHTML = bubbleInner(m);
      return;
    }
    appendBubble(m);
  }

  function applyStatus(id, status) {
    var row = state.byId[id];
    if (row && row._meta) row._meta.textContent = timeLabel() + statusTick(status);
  }

  // ---- reply context -------------------------------------------------------
  function setReply(m) {
    state.replyTo = { externalId: m.externalId, body: m.media ? (m.media.kind || "attachment") : m.body };
    replyQt.textContent = state.replyTo.body || "";
    replyBar.classList.add("on");
    textInput.focus();
  }
  function clearReply() {
    state.replyTo = null;
    replyBar.classList.remove("on");
  }

  // ---- sending -------------------------------------------------------------
  function newClientId() {
    return "c" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function optimistic(clientMsgId, body, media) {
    var m = {
      direction: "in",
      body: body,
      media: media || null,
      status: "sent",
      createdAt: new Date().toISOString(),
      replyTo: state.replyTo ? { body: state.replyTo.body } : null,
      _local: true,
    };
    var row = appendBubble(m);
    state.pending[clientMsgId] = row;
  }
  function emitMessage(payload) {
    if (!state.socket || !state.socket.connected) return false;
    state.socket.emit("visitor:message", payload, function (ack) {
      if (ack && ack.ok === false) console.warn("[webchat] send rejected:", ack.error);
    });
    return true;
  }
  function firstSendExtras(payload) {
    if (state.preChat) {
      payload.preChat = state.preChat;
      state.preChat = null; // sent once
    }
  }
  function onSend() {
    if (!state.formDone || state.sending) return;
    var text = textInput.value.trim();
    if (!text) return;
    textInput.value = "";
    var cid = newClientId();
    var payload = { clientMsgId: cid, body: text };
    if (state.replyTo) payload.replyToExternalId = state.replyTo.externalId;
    firstSendExtras(payload);
    optimistic(cid, text, null);
    clearReply();
    emitMessage(payload);
  }

  function onPickFile() {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file || !state.formDone) return;
    var fd = new FormData();
    fd.append("file", file);
    attachBtn.disabled = true;
    fetch(apiBase + "/api/widget/media?key=" + encodeURIComponent(siteKey), {
      method: "POST",
      body: fd,
    })
      .then(function (r) {
        if (!r.ok) throw new Error("upload failed (" + r.status + ")");
        return r.json();
      })
      .then(function (media) {
        var cid = newClientId();
        var payload = {
          clientMsgId: cid,
          body: "",
          media: {
            mediaKey: media.mediaKey,
            mediaUrl: media.mediaUrl,
            kind: media.kind,
            mimeType: media.mimeType,
            sizeBytes: media.sizeBytes,
            filename: media.filename,
          },
        };
        if (state.replyTo) payload.replyToExternalId = state.replyTo.externalId;
        firstSendExtras(payload);
        // Optimistic placeholder — the echoed frame (with the real message id +
        // servable media URL) replaces it within ~100ms, so we don't try to
        // render the not-yet-persisted media here.
        optimistic(cid, "📎 " + (media.kind || "file") + " · sending…", null);
        clearReply();
        emitMessage(payload);
      })
      .catch(function (e) {
        console.error("[webchat]", e);
      })
      .then(function () {
        attachBtn.disabled = false;
      });
  }

  // ---- connect -------------------------------------------------------------
  function connect() {
    var socket = window.io(apiBase + "/widget", {
      path: "/api/socket",
      transports: ["websocket"],
      auth: { siteKey: siteKey, visitorId: state.visitorId },
    });
    state.socket = socket;
    socket.on("ready", onReady);
    socket.on("history", function (p) {
      var msgs = (p && p.messages) || [];
      if (msgs.length) {
        hasHistory = true;
        bodyEl.innerHTML = "";
        state.formDone = true;
        composer.style.display = "flex";
        msgs.forEach(function (m) {
          appendBubble(m);
        });
      }
    });
    socket.on("message", upsertMessage);
    socket.on("message:status", function (p) {
      if (p && p.id) applyStatus(p.id, p.status);
    });
    socket.on("connect_error", function (e) {
      console.warn("[webchat] connect_error:", e && e.message);
    });
  }

  function boot() {
    connect();
  }
  // Load socket.io UMD (same origin, classic script → no CORS), then boot.
  if (window.io) boot();
  else {
    var s = document.createElement("script");
    s.src = staticBase + "/webchat/socket.io.min.js";
    s.async = true;
    s.onload = boot;
    s.onerror = function () {
      console.error("[webchat] failed to load socket.io client");
    };
    document.head.appendChild(s);
  }
})();
