/* Website chat widget — first-party embeddable live chat (v3).

   Embed (floating bubble):
     <script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..." defer></script>

   Deploy modes (data-* attributes):
     data-webchat-launcher="on|off"     hide the bubble, open via JS API
     data-webchat-position="right|left" bubble side
     data-webchat-label="Chat with us"  text pill beside the bubble
     data-webchat-target="#el"          INLINE: render the chat inside #el (always open)
     data-webchat-api="https://api"     override API origin (CDN / dev split)

   JS API (wire any link/button):  CCPWebchat.open() / .close() / .toggle()
     <a href="#" onclick="CCPWebchat.open();return false">Chat with us</a>

   Shadow-DOM isolated, reconnect-safe, offline queue, refresh-safe, theming
   (logo/avatar/colors/font/light-dark), a11y, media, RTL. No reactions. */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector("script[data-webchat-key]");
  if (!script) return;
  var siteKey = script.getAttribute("data-webchat-key");
  if (!siteKey) return void console.error("[webchat] data-webchat-key missing");
  var apiBase, staticBase;
  try {
    staticBase = new URL(script.src).origin;
    apiBase = ((script.getAttribute("data-webchat-api") || "").trim() || staticBase).replace(/\/$/, "");
  } catch (e) { return void console.error("[webchat] cannot resolve origin", e); }
  if (document.getElementById("ccp-webchat-root")) return;

  // deploy-mode attributes
  var A = {
    launcher: (script.getAttribute("data-webchat-launcher") || "on").toLowerCase() !== "off",
    position: (script.getAttribute("data-webchat-position") || "right").toLowerCase() === "left" ? "left" : "right",
    label: (script.getAttribute("data-webchat-label") || "").trim(),
    target: (script.getAttribute("data-webchat-target") || "").trim(),
  };
  var INLINE = !!A.target;

  var BRAND = "#4f46e5";
  var MAX_BYTES = 25 * 1024 * 1024;
  var SEND_TIMEOUT = 12000;
  var K = {
    visitor: "ccp_wc_visitor_" + siteKey, draft: "ccp_wc_draft_" + siteKey,
    seen: "ccp_wc_seen_" + siteKey, outbox: "ccp_wc_outbox_" + siteKey,
    // "this visitor has chatted before" — drives eager connect on later visits so
    // agent replies and the unread badge still arrive without opening the panel.
    chatted: "ccp_wc_chatted_" + siteKey,
    // Panel open/closed across reloads. Without it a refresh mid-conversation
    // silently closed the chat and the visitor had to hunt for the bubble again;
    // Intercom/Crisp/Drift all restore this.
    open: "ccp_wc_open_" + siteKey,
    // "this visitor already completed the pre-chat form" — covers the window where
    // they submitted but haven't sent a message yet (so there's no history to infer
    // it from). Without it a refresh in that gap re-asks for their details.
    prechat: "ccp_wc_prechat_" + siteKey,
    /** Panel size the visitor dragged to ({w,h}) — persisted like the open-state. */
    size: "ccp_wc_size_" + siteKey,
    /** Epoch ms of the visitor's last activity — drives the idle-session reset. */
    active: "ccp_wc_active_" + siteKey,
    /** One-shot marker set by the explicit "Start a new conversation" control, read
     *  once on the next boot so the first message tells the server this fresh
     *  conversation was a deliberate restart (→ a timeline note for the agent). */
    restart: "ccp_wc_restart_" + siteKey,
    /** Last-applied appearance payload ({name, config}), re-applied synchronously
     *  on the next boot so the first paint carries the org's real branding instead
     *  of flashing the built-in default and re-theming when the config arrives. */
    theme: "ccp_wc_theme_" + siteKey,
    /** Visitor-side sound mute (⋯ menu) — a per-device preference, so it survives
     *  identity resets like the panel size does. */
    muted: "ccp_wc_muted_" + siteKey,
  };
  // Storage access itself can THROW (Safari private mode, "block all cookies"), so
  // every call is guarded. Fall back localStorage → sessionStorage → in-memory:
  // without the session tier a storage-blocked browser minted a fresh visitorId on
  // every pageview, so one person browsing five pages created five Contacts and
  // five Conversations in the client's inbox, and a mid-chat refresh orphaned the
  // thread. sessionStorage at least holds the identity for the tab's lifetime.
  var memStore = {};
  function lsGet(k) {
    try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (_e) {}
    try { var s = sessionStorage.getItem(k); if (s !== null) return s; } catch (_e) {}
    return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null;
  }
  function lsSet(k, v) {
    memStore[k] = v;
    try { localStorage.setItem(k, v); return; } catch (_e) {}
    // The write failed (quota/blocked) but an OLD value may sit in localStorage —
    // and lsGet prefers localStorage, so it would shadow the fresher fallback copy
    // forever. Drop the stale primary before falling back.
    try { localStorage.removeItem(k); } catch (_e) {}
    try { sessionStorage.setItem(k, v); } catch (_e) {}
  }
  function lsDel(k) {
    delete memStore[k];
    try { localStorage.removeItem(k); } catch (_e) {}
    try { sessionStorage.removeItem(k); } catch (_e) {}
  }
  var reduceMotion = false;
  try { reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_e) {}

  // visitorId is the ONLY credential authenticating this visitor: possession
  // grants their whole thread history (socket handshake) and their media
  // (GET /api/widget/media). It must be unguessable, so prefer the CSPRNG —
  // Math.random() is xorshift128+ with a predictable Date.now() suffix.
  function newVisitorId() {
    try {
      if (window.crypto && crypto.randomUUID) return "vis_" + crypto.randomUUID();
      if (window.crypto && crypto.getRandomValues) {
        var a = new Uint8Array(16); crypto.getRandomValues(a);
        return "vis_" + Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
      }
    } catch (_e) { /* fall through */ }
    return "vis_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  /**
   * How long a visitor keeps the same conversation across visits.
   *
   * A refresh or a same-week return continues the thread; a return after this long
   * with no activity starts fresh. 30 days is the Intercom/Crisp norm. Counter-
   * intuitively a SHORTER window is worse here, not better: the schema pins one
   * conversation per contact forever, so "start fresh" means a new visitor id =
   * new Contact + Conversation, and a 24h window would multiply rows and scatter a
   * returning visitor across unlinked inbox threads. It never affects performance —
   * history replay is a fixed 50 rows regardless of thread age.
   */
  var SESSION_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
  // Drafts and queued sends older than this are discarded on boot. A half-typed
  // sentence or a failed upload resurfacing days later is confusing — it reads as a
  // bug, not a feature. Independent of the 30d session window above.
  var STALE_CLIENT_STATE_MS = 24 * 60 * 60 * 1000;
  function isFresh(ts) { return ts && Date.now() - ts < STALE_CLIENT_STATE_MS; }

  /**
   * Clear everything tied to the current visitor identity and mint a new one — the
   * mechanism behind both idle-expiry and the explicit "start a new conversation".
   * A rotated id simply resolves to no contact server-side, so ingest creates a
   * fresh one exactly as for a first-time visitor. No server call needed.
   */
  function resetVisitorIdentity() {
    [K.visitor, K.chatted, K.seen, K.open, K.draft, K.outbox, K.prechat, K.active].forEach(lsDel);
    // CLOSE FIRST. `deleteDatabase` blocks silently while any connection is open,
    // and idb() holds one for the tab's lifetime. This used to be masked by the
    // page reload that followed; ending the session in place made the delete a
    // no-op, so a "cleared" chat's queued attachments survived and were re-sent
    // under the NEXT visitor identity. The confirm promises the opposite.
    idbClose();
    try { indexedDB.deleteDatabase("ccp_wc_" + siteKey); } catch (_e) {}
  }

  // Expire an idle session before we read the id, so the rest of boot sees a clean
  // first-time visitor. A missing/na timestamp (older widget, storage just cleared)
  // is treated as fresh, never as expired.
  (function expireIdleSession() {
    var last = Number(lsGet(K.active) || 0);
    if (last && Date.now() - last > SESSION_MAX_IDLE_MS) resetVisitorIdentity();
  })();

  var S = {
    socket: null, conn: "connecting", open: INLINE, ready: false, viewInit: false,
    formDone: false, closed: false, cfg: null, preChat: null, replyTo: null, fatal: false,
    /** File picked but not sent yet — see stageFile/clearStage. */
    staged: null,
    /** Whether an agent is currently online — from the server `agents` frame. */
    agentsOnline: undefined,
    byId: {}, pending: {}, unread: 0, lastSeenTs: Number(lsGet(K.seen) || 0),
    lastGroup: null, lastDayLabel: null, stick: true, readTimer: null, typingClear: null,
    hasMore: false, oldestCursor: null, loadingOlder: false, typingOn: false, recording: null,
    /** Last visibility reported to the server (see emitPresence). Server assumes
     *  visible on connect, so start matched to that. */
    presenceSent: true,
    visitorId: lsGet(K.visitor) || newVisitorId(),
    /** Set when this boot follows an explicit "Start a new conversation" — attached
     *  to the first message so the server records the restart note, then cleared. */
    startedNew: false,
  };
  lsSet(K.visitor, S.visitorId);
  // Consume the one-shot restart marker (survives the reset+reload).
  if (lsGet(K.restart)) { S.startedNew = true; lsDel(K.restart); }
  var baseTitle = document.title, titleTimer = null;

  // ── helpers ────────────────────────────────────────────────────────────────
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === "class") n.className = props[k];
      else if (k === "style") n.setAttribute("style", props[k]);
      else if (k === "html") n.innerHTML = props[k];
      else if (k.slice(0, 2) === "on" && typeof props[k] === "function") n.addEventListener(k.slice(2).toLowerCase(), props[k]);
      else if (props[k] != null) n.setAttribute(k, props[k]);
    }
    if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function hex(s) { if (typeof s !== "string") return null; var v = s.trim().toLowerCase(); if (/^#[0-9a-f]{3}$/.test(v)) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]; return /^#[0-9a-f]{6}$/.test(v) ? v : null; }
  function contrastOn(h) { if (!/^#[0-9a-f]{6}$/i.test(h)) return "#fff"; var r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? "#0d1220" : "#fff"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function linkify(t) { var re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/g, out = "", last = 0, m; while ((m = re.exec(t))) { out += esc(t.slice(last, m.index)); out += '<a href="' + esc(m[0]) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(m[0]) + "</a>"; last = m.index + m[0].length; } out += esc(t.slice(last)); return out; }
  function initials(n) { if (!n) return "•"; var p = n.trim().split(/\s+/).slice(0, 2); return p.map(function (x) { return x[0]; }).join("").toUpperCase() || "•"; }
  function fmtTime(iso) { return (iso ? new Date(iso) : new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  /** Human labels for local placeholder bubbles ("📎 Photo", not "📎 image"). */
  var KIND_LABEL = { image: "Photo", video: "Video", audio: "Audio", document: "Document" };
  function fmtDay(iso) { var d = iso ? new Date(iso) : new Date(), t = new Date(), y = new Date(t - 864e5); if (d.toDateString() === t.toDateString()) return "Today"; if (d.toDateString() === y.toDateString()) return "Yesterday"; return d.toLocaleDateString([], { month: "short", day: "numeric" }); }
  function newCid() { return "c" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function mediaUrl(id, thumb) { return apiBase + "/api/widget/media/" + encodeURIComponent(id) + "?key=" + encodeURIComponent(siteKey) + "&v=" + encodeURIComponent(S.visitorId) + (thumb ? "&thumb=1" : ""); }

  // ── styles ───────────────────────────────────────────────────────────────
  var host = el("div", { id: "ccp-webchat-root" });
  host.style.all = "initial";
  // Mount on <html>, not <body>, and force `position:fixed` on the host itself.
  // Two ways a real customer site broke the widget otherwise:
  //   1. `all:initial` makes the host `display:inline`, so a host page whose body
  //      is `display:grid|flex` treated it as a track/item — adding a stray empty
  //      row plus its gap, i.e. a visible layout shift on THEIR page.
  //   2. Any ancestor with transform/filter/will-change (page-transition wrappers,
  //      parallax libraries) becomes the containing block for `position:fixed`, so
  //      the launcher and panel anchored to that element instead of the viewport
  //      and rendered in the wrong place or off-screen.
  // Escaping <body> and pinning the host sidesteps both. Inline mode re-parents
  // into the target element below and clears these.
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("top", "0", "important");
  host.style.setProperty("left", "0", "important");
  host.style.setProperty("width", "0", "important");
  host.style.setProperty("height", "0", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  (document.documentElement || document.body).appendChild(host);
  var shadow = host.attachShadow({ mode: "open" });
  var css = [
    ":host,*{box-sizing:border-box}",
    ".root{--c:" + BRAND + ";--ct:#fff;--lc:" + BRAND + ";--uc:" + BRAND + ";--uct:#fff;--surface:#fff;--surface2:#f7f8fa;--inb:#fff;--border:#eceef2;--ink:#101828;--ink2:#5b6a83;--radius:22px;font-family:var(--font,ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif);color:var(--ink)}",
    ".root.dark{--surface:#0f1626;--surface2:#0b101c;--inb:#1a2335;--border:#222c3f;--ink:#e8edf6;--ink2:#93a1b8}",
    // Inline embeds fill their host container. `min-height` is the safety net: an
    // ancestor chain with no resolved height makes `height:100%` collapse to zero,
    // which reads as "the widget didn't load" rather than "size your container".
    // Wider media too — a full-page inline chat showing 236px images looked broken.
    ".root.inl{height:100%;min-height:320px;--media-max:min(100%,420px)}",
    ".launch{position:fixed;bottom:calc(22px + env(safe-area-inset-bottom,0px));z-index:2147483646;display:flex;align-items:center;gap:10px;border:0;background:transparent;cursor:pointer;padding:0}",
    ".launch.right{right:22px;flex-direction:row}.launch.left{left:22px;flex-direction:row-reverse}",
    // NOTE on the doubled `background` declarations here and below: color-mix() is
    // Chrome 111+/Safari 16.2+, and an engine that doesn't grok it drops the WHOLE
    // declaration. Without a flat fallback first, iOS 15 and the Facebook/Instagram
    // in-app browsers render an invisible launcher, a white-on-white header, and
    // unreadable outgoing bubbles. The flat colour lands first; modern engines then
    // override it with the gradient.
    // Icon color derives from the launcher color (--lct, set in applyConfig) — a
    // hardcoded #fff was invisible on a light launcher color.
    ".launch .b{width:60px;height:60px;border-radius:9999px;background:var(--lc);background:linear-gradient(145deg,var(--lc),color-mix(in srgb,var(--lc) 78%,#000));color:var(--lct,#fff);display:flex;align-items:center;justify-content:center;box-shadow:0 12px 28px -10px color-mix(in srgb,var(--lc) 55%,transparent),0 3px 8px rgba(16,24,40,.10);transition:transform .2s cubic-bezier(.2,.8,.2,1)}",
    ".launch:hover .b{transform:scale(1.06)}.launch:active .b{transform:scale(.95)}.launch .b svg{width:28px;height:28px}.launch .b img{width:30px;height:30px;border-radius:9999px;object-fit:cover}",
    ".launch .lbl{background:var(--surface);color:var(--ink);font-size:13.5px;font-weight:600;padding:9px 14px;border-radius:9999px;box-shadow:0 8px 22px -8px rgba(0,0,0,.25);white-space:nowrap;display:none}",
    ".launch.showlbl .lbl{display:block}",
    ".launch.pre{visibility:hidden}",
    ".badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:9999px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--surface)}.badge.on{display:flex}",
    ".lwrap{position:relative;display:flex}",
    // 376×600 default — corner-chat scale (Crisp/Drift territory); the visitor can
    // widen it with the expand control when they want more room.
    // The hairline is a TRANSLUCENT dark ring, not a solid light one. `var(--border)`
    // (#e6e9f0) is only correct against a light page — on a dark customer site it
    // painted a visible white outline around the panel, which reads as a cheap
    // sticker rather than a floating surface. Translucent ink disappears on dark
    // backgrounds and still separates the panel on light ones.
    ".panel{position:fixed;bottom:94px;z-index:2147483647;width:376px;max-width:calc(100vw - 24px);height:min(600px,calc(100vh - 116px));background:var(--surface);border-radius:var(--radius);box-shadow:0 24px 60px -12px rgba(15,23,42,.30),0 2px 10px rgba(15,23,42,.10),0 0 0 1px rgba(15,23,42,.07);display:none;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px) scale(.98)}",
    ".root.dark .panel{box-shadow:0 24px 60px -12px rgba(0,0,0,.62),0 2px 10px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.09)}",
    ".panel.right{right:22px}.panel.left{left:22px}",
    ".panel.open{display:flex}.panel.in{opacity:1;transform:none;transition:opacity .24s ease,transform .28s cubic-bezier(.16,1,.3,1)}",
    ".panel.inline{position:relative;right:auto;left:auto;bottom:auto;width:100%;height:100%;max-width:100%;border-radius:inherit;opacity:1;transform:none;display:flex;box-shadow:0 0 0 1px rgba(15,23,42,.07)}",
    ".root.dark .panel.inline{box-shadow:0 0 0 1px rgba(255,255,255,.09)}",
    "@media (max-width:480px){.panel:not(.inline){right:0;left:0;bottom:0;top:0;width:100vw;max-width:100vw;height:100vh;height:100dvh;border-radius:0}}",
    // iOS Safari auto-zooms the HOST PAGE when a form control with font-size < 16px
    // takes focus, and never zooms back out — so tapping the message box left the
    // client's site zoomed in and horizontally scrollable. 16px on mobile is the
    // documented way to opt out; desktop keeps the tighter 14px above.
    "@media (max-width:480px){.composer textarea,.form input{font-size:16px}}",
    "header{display:flex;align-items:center;gap:11px;padding:16px 17px;background:var(--c);background:linear-gradient(135deg,color-mix(in srgb,var(--c) 96%,#fff),color-mix(in srgb,var(--c) 88%,#000));color:var(--ct);flex:0 0 auto;box-shadow:inset 0 -1px 0 rgba(255,255,255,.10)}",
    ".hava{width:38px;height:38px;border-radius:12px;background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;position:relative;overflow:hidden;flex:0 0 auto}.hava img{width:100%;height:100%;object-fit:cover}",
    ".hdot{position:absolute;right:-2px;bottom:-2px;width:12px;height:12px;border-radius:9999px;background:#22c55e;box-shadow:0 0 0 2px var(--c)}.hdot.re{background:#f59e0b}.hdot.off{background:#9ca3af}",
    ".htxt{flex:1;min-width:0}.htxt b{display:block;font-size:15px;font-weight:650;letter-spacing:-.012em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.25}.htxt small{font-size:11.5px;opacity:.82;letter-spacing:-.004em}.htxt small.live{opacity:1;font-weight:600}",
    // Drag-to-resize grip on the panel's OUTER top corner (the one pointing away
    // from the screen edge the panel is anchored to). Replaced an expand/restore
    // toggle button: two icon states in the header to pick between two fixed sizes,
    // when what people want is simply "a bit bigger". Desktop only — the mobile
    // panel is already full-screen. Generous 18px target over a subtle 10px mark.
    "@media (max-width:480px){.rsz{display:none}}",
    // INVISIBLE by design — the cursor is the affordance, exactly like an OS window
    // corner. A drawn grip mark sat on the header's rounded corner and read as a
    // rendering artifact, which is worse than no affordance at all.
    ".rsz{position:absolute;top:0;width:24px;height:24px;z-index:7;touch-action:none}",
    ".panel.right .rsz{left:0;cursor:nwse-resize}.panel.left .rsz{right:0;cursor:nesw-resize}",
    ".hmw{position:relative;margin-left:auto;display:flex}",
    ".hmenu{position:absolute;top:calc(100% + 6px);right:0;min-width:190px;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:12px;box-shadow:0 18px 40px -12px rgba(15,23,42,.3);padding:5px;display:none;flex-direction:column;z-index:3}.hmenu.on{display:flex}",
    ".hmi{background:transparent;border:0;text-align:left;font:inherit;font-size:13.5px;color:inherit;padding:9px 11px;border-radius:8px;cursor:pointer;white-space:nowrap}.hmi:hover{background:var(--surface2)}",
    ".hx{background:transparent;border:0;color:inherit;cursor:pointer;opacity:.9;padding:7px;border-radius:9px;display:flex}.hx:hover{opacity:1;background:rgba(255,255,255,.16)}.hx svg{width:18px;height:18px}",
    ".awaybar{background:color-mix(in srgb,var(--ink2) 8%,var(--surface));color:var(--ink2);font-size:12px;text-align:center;padding:7px 12px;flex:0 0 auto;display:none;border-bottom:1px solid var(--border)}.awaybar.on{display:block}",
    ".restrip{background:#fff7ed;color:#9a3412;font-size:12px;text-align:center;padding:6px;flex:0 0 auto;display:none}.root.dark .restrip{background:#3a2a12;color:#fbbf77}.restrip.on{display:block}",
    ".body{flex:1 1 auto;overflow-y:auto;padding:18px 16px 16px;background:var(--surface2);display:flex;flex-direction:column;gap:0;position:relative;scroll-behavior:smooth}",
    ".body::-webkit-scrollbar{width:8px}.body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--ink2) 35%,transparent);border-radius:8px}",
    ".day{align-self:center;font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);background:color-mix(in srgb,var(--ink2) 9%,transparent);border-radius:9999px;padding:4px 12px;margin:12px 0 6px}",
    ".sname{font-size:11px;font-weight:600;color:var(--ink2);letter-spacing:.005em;margin:9px 0 2px 40px}",
    ".sname .aib{display:inline-block;margin-left:5px;padding:0 5px;border-radius:9999px;font-size:9.5px;font-weight:700;letter-spacing:.03em;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent);vertical-align:middle}",
    ".mr .av.aiav{background:linear-gradient(145deg,var(--c),color-mix(in srgb,var(--c) 55%,#000));font-size:9.5px}",
    ".mr{display:flex;gap:8px;align-items:flex-end;max-width:86%;margin-top:9px}.mr.grp{margin-top:3px}.mr.out{align-self:flex-end;flex-direction:row-reverse}.mr.in{align-self:flex-start}",
    ".mr .av{width:28px;height:28px;border-radius:9999px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:650;letter-spacing:.02em;color:var(--c);background:color-mix(in srgb,var(--c) 13%,var(--surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 16%,transparent);overflow:hidden}.mr .av img{width:100%;height:100%;object-fit:cover}.mr.out .av,.mr.grp .av{display:none}.mr.grp{margin-left:36px}.mr.grp.out{margin-left:0;margin-right:0}",
    ".col{display:flex;flex-direction:column;min-width:0}.mr.out .col{align-items:flex-end}",
    ".bubble{padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.55;letter-spacing:-.003em;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;max-width:100%;box-shadow:0 1px 2px rgba(16,24,40,.04)}",
    reduceMotion ? "" : ".bubble.anim{animation:cin .2s ease-out}@keyframes cin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
    ".mr.out .bubble{background:var(--uc);background:linear-gradient(160deg,color-mix(in srgb,var(--uc) 97%,#fff),color-mix(in srgb,var(--uc) 90%,#000));color:var(--uct);border-bottom-right-radius:7px;box-shadow:0 2px 8px -2px color-mix(in srgb,var(--uc) 38%,transparent)}",
    ".mr.in .bubble{background:var(--inb);color:var(--ink);border:1px solid var(--border);border-bottom-left-radius:7px}",
    ".bubble a{color:inherit;text-decoration:underline;text-underline-offset:2px}",
    // …except an attachment row, which is a control, not a link in prose. Needs
    // to out-specify `.bubble a` above, which is why it is not just on `.doc`.
    ".bubble a.doc,.bubble a.doc:hover{text-decoration:none}",
    ".meta{font-size:10.5px;color:var(--ink2);margin:4px 6px 0;display:flex;gap:4px;align-items:center;font-variant-numeric:tabular-nums;opacity:.9}.tick.err{color:#ef4444}.retry{color:#ef4444;cursor:pointer;text-decoration:underline}.tick.read{color:#38bdf8}",
    ".rep{opacity:0;background:transparent;border:0;color:var(--ink2);cursor:pointer;font-size:14px;align-self:center;padding:4px;border-radius:7px;transition:opacity .12s}.mr:hover .rep{opacity:.7}.rep:hover{opacity:1;background:color-mix(in srgb,var(--ink2) 14%,transparent)}",
    ".rq{border-left:3px solid rgba(0,0,0,.18);padding:2px 8px;margin-bottom:5px;font-size:12.5px;opacity:.85;max-height:44px;overflow:hidden}.mr.out .rq{border-left-color:rgba(255,255,255,.55)}.rq.jump{cursor:pointer}.rq.jump:hover{opacity:1}",
    // Brief highlight on the message a quote jumped to, so the eye lands on it.
    reduceMotion ? ".mr.flash .bubble{box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 45%,transparent)}" : ".mr.flash .bubble{animation:rqring 1.4s ease}@keyframes rqring{0%,100%{box-shadow:0 0 0 0 transparent}28%,62%{box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 45%,transparent)}}",
    ".media{min-height:48px;max-width:100%}.media img,.media video{max-width:236px;max-width:min(var(--media-max,236px),100%);height:auto;max-height:250px;border-radius:13px;display:block;cursor:pointer;background:color-mix(in srgb,var(--ink2) 10%,transparent)}.media audio{width:100%;min-width:min(260px,100%);max-width:100%}",
    // Voice note: a purpose-built row, not native controls. Sized in ch/flex so it
    // fills whatever width the bubble has — including a resized panel.
    ".vn{display:flex;align-items:center;gap:10px;min-width:180px;padding:2px 0}",
    ".vnplay{flex:0 0 auto;width:34px;height:34px;border:0;border-radius:9999px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,currentColor 14%,transparent);color:inherit;transition:.12s}.vnplay:hover{background:color-mix(in srgb,currentColor 22%,transparent)}.vnplay:disabled{opacity:.5;cursor:default}.vnplay svg{width:16px;height:16px}",
    ".vnbar{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}",
    // Generous hit area (12px) around a 4px visual track — a 4px target is
    // untappable on touch, which is half of why the old player felt broken.
    ".vntrack{position:relative;height:12px;display:flex;align-items:center;cursor:pointer;touch-action:none}.vntrack::before{content:'';position:absolute;left:0;right:0;height:4px;border-radius:9999px;background:color-mix(in srgb,currentColor 22%,transparent)}",
    ".vntrack i{position:relative;height:4px;border-radius:9999px;background:currentColor;width:0;transition:width .1s linear}",
    ".vntime{font-size:11.5px;opacity:.75;font-variant-numeric:tabular-nums}",
    ".vnname{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:1px}.vn.afile{min-width:210px}",
    ".doc{display:flex;align-items:center;gap:9px;text-decoration:none;color:inherit;font-size:13px}.doc .ic{width:32px;height:32px;flex:0 0 auto;border-radius:8px;background:rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center}",
    ".prog{height:4px;background:rgba(0,0,0,.14);border-radius:9999px;overflow:hidden;margin-top:7px}.prog i{display:block;height:100%;background:currentColor;width:0;transition:width .15s}",
    ".typ{display:inline-flex;gap:4px;padding:4px 2px}.typ i{width:6px;height:6px;background:var(--ink2);border-radius:9999px;animation:tb 1s infinite}.typ i:nth-child(2){animation-delay:.15s}.typ i:nth-child(3){animation-delay:.3s}@keyframes tb{0%,80%,100%{transform:scale(.6);opacity:.5}40%{transform:scale(1);opacity:1}}",
    ".pills{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}.pill{background:var(--surface);color:var(--c);border:1px solid color-mix(in srgb,var(--c) 22%,var(--border));border-radius:9999px;padding:8px 15px;font-size:13px;font-weight:550;letter-spacing:-.004em;cursor:pointer;transition:.16s ease;box-shadow:0 1px 2px rgba(16,24,40,.04)}.pill:hover{background:var(--c);color:var(--ct);border-color:var(--c)}",
    ".sys{align-self:center;font-size:12.5px;line-height:1.5;color:var(--ink2);background:color-mix(in srgb,var(--ink2) 8%,transparent);border-radius:13px;padding:8px 14px;text-align:center;margin:8px 0;max-width:90%}",
    ".sys.closed{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:88%}",
    // Loading skeleton. Tinted from --ink2 so it inherits light/dark automatically,
    // and the sweep is a background-position animation (compositor-friendly, no
    // layout work) rather than an opacity pulse on three separate nodes.
    ".skel{display:flex;flex-direction:column;gap:12px;padding-top:4px}",
    // `width`, not `max-width`: the bubble widths are percentages, and inside a
    // shrink-to-fit row they would resolve against a container sized by its own
    // content — i.e. to zero, leaving only the avatars visible.
    ".skrow{display:flex;align-items:flex-end;gap:8px;width:86%}.skrow.out{align-self:flex-end;flex-direction:row-reverse}.skrow.in{align-self:flex-start}",
    ".skav{width:28px;height:28px;border-radius:9999px;flex:0 0 auto}",
    ".skb{height:38px;border-radius:17px}",
    ".skav,.skb{background:color-mix(in srgb,var(--ink2) 13%,transparent)}",
    reduceMotion
      ? ""
      : ".skav,.skb{background-image:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--ink2) 9%,transparent) 50%,transparent 100%);background-size:200% 100%;animation:skw 1.4s ease-in-out infinite}@keyframes skw{from{background-position:150% 0}to{background-position:-50% 0}}",
    // End-of-session state: what happened, a rule, and the one way forward.
    ".ended{margin-top:auto;padding-top:14px;border-top:1px solid var(--border);display:flex;flex-direction:column;align-items:center;gap:11px}",
    ".ended .em{font-size:13.5px;line-height:1.5;color:var(--ink2);text-align:center;letter-spacing:-.004em}",
    ".cstart{border:1px solid color-mix(in srgb,var(--c) 35%,var(--border));background:var(--surface);color:var(--c);font:inherit;font-size:12.5px;font-weight:600;letter-spacing:-.004em;border-radius:9999px;padding:8px 16px;cursor:pointer;transition:.16s ease;box-shadow:0 1px 2px rgba(16,24,40,.05)}.cstart:hover{background:var(--c);color:var(--ct)}",
    ".rconf{align-self:center;max-width:88%;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;margin:6px 0;box-shadow:0 8px 22px -10px rgba(15,23,42,.25)}.rct{font-size:13px;color:var(--ink);margin-bottom:10px}.rca{display:flex;gap:8px;justify-content:flex-end}",
    ".rcy{border:0;background:var(--c);color:var(--ct);font:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 14px;cursor:pointer}.rcn{border:0;background:transparent;color:var(--ink2);font:inherit;font-size:12.5px;padding:7px 10px;cursor:pointer}.rcn:hover{color:var(--ink)}",
    ".newp{position:absolute;left:50%;transform:translateX(-50%);top:-46px;background:var(--c);color:var(--ct);border:0;border-radius:9999px;padding:7px 15px;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 8px 20px -6px rgba(0,0,0,.35);display:none;white-space:nowrap;z-index:2}.newp.on{display:block}",
    ".form{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:11px;margin-top:6px}.form h3{margin:0;font-size:15px;font-weight:700}.form p{margin:0;font-size:13px;color:var(--ink2)}.form .fld{display:flex;flex-direction:column;gap:5px}.form label{font-size:12px;font-weight:600}.form input,.form select{font:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--border);border-radius:11px;outline:none;background:var(--surface);color:var(--ink);width:100%;appearance:auto}.form input:focus,.form select:focus{border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 18%,transparent)}",
    ".err{color:#dc2626;font-size:12px}",
    // Stepped pre-chat form: answered steps collapse into a quiet summary, and the
    // nav row keeps Back / "N of M" / Next on one line so the card height is stable
    // between steps (a jumping card feels broken).
    ".fsum{display:flex;flex-direction:column;gap:4px}.fsumrow{display:flex;gap:8px;font-size:12px;color:var(--ink2)}.fsumrow .k{font-weight:600}.fsumrow .v{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".fnav{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:2px}.fcount{font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums}",
    ".fback{border:0;background:transparent;color:var(--ink2);font:inherit;font-size:13px;cursor:pointer;padding:6px 2px}.fback:hover{color:var(--ink)}",
    ".fnext{width:auto;min-width:104px;height:38px;border-radius:11px;font-weight:600;padding:0 18px}",
    ".rc{display:none;align-items:center;gap:9px;padding:8px 14px;background:color-mix(in srgb,var(--c) 8%,var(--surface));border-top:1px solid var(--border);font-size:12.5px;color:var(--ink);flex:0 0 auto}.rc.on{display:flex}.rc .qt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rc button{border:0;background:transparent;cursor:pointer;color:var(--ink2);font-size:16px}",
    ".composer{padding:12px 14px calc(14px + env(safe-area-inset-bottom,0px));background:var(--surface);flex:0 0 auto;position:relative;box-shadow:inset 0 1px 0 var(--border)}",
    ".emw{position:relative;display:flex}",
    // Fixed-width cells that add up to the container width EXACTLY, and overflow:
    // visible — no scrollbar. 15 emojis in 8 columns = two clean rows (8 + 7).
    ".emp{position:absolute;bottom:calc(100% + 8px);left:0;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 14px 34px -10px rgba(15,23,42,.3);padding:6px;display:none;grid-template-columns:repeat(8,30px);gap:2px;overflow:visible;z-index:4}.emp.on{display:grid}",
    ".emo{width:30px;height:30px;border:0;background:transparent;cursor:pointer;font-size:18px;line-height:1;padding:0;border-radius:7px;display:flex;align-items:center;justify-content:center}.emo:hover{background:var(--surface2)}",
    // Staged-attachment chip: the file the visitor picked but hasn't sent yet.
    ".stg{display:none;align-items:center;gap:10px;margin-bottom:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:14px}.stg.on{display:flex}.stg img{width:40px;height:40px;flex:0 0 auto;object-fit:cover;border-radius:9px}.stg .ic{width:40px;height:40px;flex:0 0 auto;border-radius:9px;background:color-mix(in srgb,var(--ink2) 12%,transparent);display:flex;align-items:center;justify-content:center;font-size:18px}.stg .meta{flex:1;min-width:0}.stg .nm{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stg .sz{font-size:11.5px;color:var(--ink2)}.stg .x{border:0;background:transparent;cursor:pointer;color:var(--ink2);font-size:17px;line-height:1;padding:4px}.stg .x:hover{color:var(--ink)}",
    ".ibar{display:flex;align-items:flex-end;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:26px;padding:5px 5px 5px 8px;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}.ibar.focus{border-color:color-mix(in srgb,var(--c) 55%,var(--border));background:var(--surface);box-shadow:0 0 0 3.5px color-mix(in srgb,var(--c) 11%,transparent)}",
    ".composer textarea{flex:1;resize:none;border:0;outline:none;background:transparent;font:inherit;font-size:14px;line-height:1.45;padding:8px 6px;max-height:112px;min-height:20px;overflow-y:hidden;color:var(--ink);appearance:none;-webkit-appearance:none}",
    ".rbtn{width:38px;height:38px;flex:0 0 auto;border:0;border-radius:9999px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:transparent;color:var(--ink2);transition:.12s}.rbtn:hover{background:color-mix(in srgb,var(--ink2) 14%,transparent);color:var(--ink)}.rbtn svg{width:19px;height:19px}",
    ".sbtn{background:var(--c);color:var(--ct);box-shadow:0 2px 8px -2px color-mix(in srgb,var(--c) 45%,transparent)}.sbtn:hover{filter:brightness(1.05);background:var(--c)}.sbtn:disabled{opacity:.4;cursor:not-allowed;filter:none}",
    ".foot{font-size:10.5px;color:var(--ink2);opacity:.75;text-align:center;letter-spacing:.02em;padding:2px 0 1px;flex:0 0 auto}.foot a{color:inherit;text-decoration:none;font-weight:600}",
    ".earlier{display:flex;justify-content:center;padding:2px 0 8px}.earlierbtn{background:var(--surface);color:var(--ink2);border:1px solid var(--border);border-radius:9999px;padding:5px 14px;font-size:12px;cursor:pointer;transition:.12s}.earlierbtn:hover{background:var(--surface2);color:var(--ink)}.earlierbtn:disabled{opacity:.6;cursor:default}",
    ".rbtn.rec{background:#ef4444;color:#fff}",
    ".recbar{display:flex;align-items:center;gap:9px;flex:1;color:var(--ink);font-size:13px;padding:0 6px}.recbar .rd{width:9px;height:9px;border-radius:9999px;background:#ef4444;animation:rpulse 1.1s infinite}@keyframes rpulse{0%,100%{opacity:1}50%{opacity:.35}}.recbar .rt{flex:1;font-variant-numeric:tabular-nums}.recbar button{border:0;background:transparent;cursor:pointer;color:var(--ink2);font-size:16px;padding:2px 4px}.recbar .snd{color:var(--c);font-weight:700}",
    // Both anchored to the PANEL, not the scrolling body: an absolutely-positioned
    // child of a scroll container scrolls WITH the content, so error toasts were
    // invisible in any conversation longer than one screenful (the exact bug class
    // the "new messages" pill was moved out of the body for).
    ".drop{position:absolute;inset:8px;background:color-mix(in srgb,var(--c) 10%,transparent);border:2px dashed var(--c);border-radius:14px;display:none;align-items:center;justify-content:center;color:var(--c);font-weight:700;z-index:5;pointer-events:none}.drop.on{display:flex}",
    ".toast{position:absolute;left:14px;right:14px;bottom:calc(100% + 10px);background:#111827;color:#fff;font-size:13px;padding:10px 13px;border-radius:12px;opacity:0;transition:opacity .2s;pointer-events:none;text-align:center;z-index:6}.toast.on{opacity:.97}",
    ".lb{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:2147483647;display:none;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}.lb.on{display:flex}.lb img{max-width:100%;max-height:100%;border-radius:10px}",
  ].join("");
  var st = document.createElement("style"); st.textContent = css; shadow.appendChild(st);
  var root = el("div", { class: "root" }); shadow.appendChild(root);

  // ── launcher ───────────────────────────────────────────────────────────────
  // Appearance cached from the last visit — parsed BEFORE the launcher exists so
  // its very first paint carries the org's real branding (no default-blue flash),
  // and so a first-EVER visit (no cache yet) mounts the launcher hidden (`pre`)
  // until the config answers. A corrupt entry is dropped, never fatal.
  var cachedCfg = null;
  try {
    var cachedRaw = lsGet(K.theme);
    if (cachedRaw) { cachedCfg = JSON.parse(cachedRaw); if (!cachedCfg || !cachedCfg.config) cachedCfg = null; }
  } catch (_e) { lsDel(K.theme); }
  // What's currently persisted — applyConfig skips the (stringify + storage) write
  // when nothing changed, which is every reconnect's `ready` frame.
  var lastThemeSnap = cachedCfg ? cachedRaw : null;
  var launcher = null, badge = el("span", { class: "badge", "aria-hidden": "true" });
  if (A.launcher && !INLINE) {
    var lb = el("span", { class: "b" });
    lb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var lwrap = el("div", { class: "lwrap" }, [lb, badge]);
    launcher = el("button", { class: "launch " + A.position + (A.label ? " showlbl" : "") + (cachedCfg ? "" : " pre"), "aria-label": "Open chat", "aria-haspopup": "dialog" },
      A.position === "left" ? [lwrap, el("span", { class: "lbl" }, A.label)] : [el("span", { class: "lbl" }, A.label), lwrap]);
    root.appendChild(launcher);
  }

  // ── panel ────────────────────────────────────────────────────────────────
  var panel = el("div", { class: "panel " + (INLINE ? "inline" : A.position), role: "dialog", "aria-modal": INLINE ? "false" : "true", "aria-label": "Chat" });
  var hava = el("div", { class: "hava" }); var havaInit = document.createTextNode("•"); hava.appendChild(havaInit);
  var hdot = el("span", { class: "hdot", "aria-hidden": "true" }); hava.appendChild(hdot);
  var titleEl = el("b", null, "Chat"); var subEl = el("small", null, "");
  var closeBtn = el("button", { class: "hx", "aria-label": "Close chat", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' });
  // Overflow menu. Expand, sound and "start a new conversation" all want a home in
  // the header, and three more icons beside ✕ is clutter — so they live behind one
  // ⋯ button, which is where every current chat product puts them.
  var menuBtn = el("button", { class: "hx", "aria-label": "More options", "aria-haspopup": "true", "aria-expanded": "false", html: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>' });
  var menuEl = el("div", { class: "hmenu", role: "menu" });
  var menuWrap = el("div", { class: "hmw" }, [menuBtn, menuEl]);
  function menuItem(label, onClick) {
    var b = el("button", { class: "hmi", type: "button", role: "menuitem" }, label);
    b.addEventListener("click", function () { closeMenu(); onClick(); });
    menuEl.appendChild(b);
    return b;
  }
  function openMenu() { menuEl.classList.add("on"); menuBtn.setAttribute("aria-expanded", "true"); }
  function closeMenu() { menuEl.classList.remove("on"); menuBtn.setAttribute("aria-expanded", "false"); }
  menuBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    menuEl.classList.contains("on") ? closeMenu() : openMenu();
  });
  // Any click elsewhere (including inside the shadow root) dismisses it.
  root.addEventListener("click", function () { closeMenu(); });
  document.addEventListener("click", function () { closeMenu(); });

  var headerCtl = [menuWrap];
  var headerEl = el("header", null, [hava, el("div", { class: "htxt" }, [titleEl, subEl])].concat(headerCtl));
  if (!INLINE) headerEl.appendChild(closeBtn);
  panel.appendChild(headerEl);

  /**
   * Drag-to-resize, from the panel's outer top corner.
   *
   * The default is right for a corner chat, but it makes media, images and long
   * messages feel cramped — so let the visitor size it to taste rather than making
   * the widget more intrusive for everyone by default. Replaces an expand/restore
   * toggle: one continuous gesture instead of a two-state button, and no second
   * icon in the header.
   *
   * Launcher modes only (an inline embed is sized by the host's container, and
   * resizing our own panel there would fight their CSS) and desktop only (the
   * mobile panel is already full-screen). Persisted like the open-state.
   */
  var SIZE_MIN_W = 340, SIZE_MIN_H = 420;
  function isResizable() { return !INLINE && window.innerWidth > 480; }
  function applyPanelSize(w, h) {
    // Clamp to the viewport so a drag can never push the panel off-screen, and to
    // a sane minimum so it can't be shrunk into an unusable sliver.
    var maxW = Math.min(760, window.innerWidth - 44);
    var maxH = window.innerHeight - 116;
    var cw = Math.max(SIZE_MIN_W, Math.min(w, Math.max(SIZE_MIN_W, maxW)));
    var ch = Math.max(SIZE_MIN_H, Math.min(h, Math.max(SIZE_MIN_H, maxH)));
    panel.style.width = cw + "px";
    panel.style.height = ch + "px";
    return { w: cw, h: ch };
  }
  /** Re-apply (or drop) the stored size — called on boot and on viewport changes,
   *  so crossing the mobile breakpoint hands sizing back to the CSS. */
  function syncPanelSize() {
    var clear = function () { panel.style.width = ""; panel.style.height = ""; };
    if (!isResizable()) return clear(); // mobile / inline — the CSS owns sizing
    var raw = lsGet(K.size);
    if (!raw) return clear();
    try {
      var s = JSON.parse(raw);
      if (s && s.w && s.h) applyPanelSize(s.w, s.h); else clear();
    } catch (_e) { lsDel(K.size); clear(); }
  }
  var rszEl = el("div", { class: "rsz", "aria-hidden": "true" });
  panel.appendChild(rszEl);
  var rszFrom = null;
  rszEl.addEventListener("pointerdown", function (e) {
    if (!isResizable()) return;
    e.preventDefault();
    var r = panel.getBoundingClientRect();
    rszFrom = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    try { rszEl.setPointerCapture(e.pointerId); } catch (_e) {}
  });
  rszEl.addEventListener("pointermove", function (e) {
    if (!rszFrom) return;
    // The panel is anchored to its bottom + its own side, so the grip's corner
    // moves AWAY from that side to grow: mirror the x delta for a left-anchored panel.
    var dx = A.position === "left" ? e.clientX - rszFrom.x : rszFrom.x - e.clientX;
    applyPanelSize(rszFrom.w + dx, rszFrom.h + (rszFrom.y - e.clientY));
  });
  function endResize() {
    if (!rszFrom) return;
    rszFrom = null;
    var r = panel.getBoundingClientRect();
    lsSet(K.size, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
    scrollToBottom(false);
  }
  rszEl.addEventListener("pointerup", endResize);
  rszEl.addEventListener("pointercancel", endResize);
  window.addEventListener("resize", syncPanelSize);
  // Reset = close this chat on this device and start fresh. Reworded from "Start a
  // new conversation" to "Clear this chat" in the menu: the model is one thread per
  // visitor, so this is a RESET (privacy on a shared computer), not a second
  // conversation — and reset actions belong in an overflow menu. The prominent,
  // discoverable version lives on the closed-chat notice (its natural moment).
  function requestReset() {
    if (!S.formDone && !lsGet(K.chatted)) { doReset(true); return; } // nothing to lose → just do it
    showResetConfirm();
  }
  /**
   * End the session IN PLACE — never reload the page.
   *
   * This used to call `location.reload()` to get a clean slate. That reloads the
   * CUSTOMER'S ENTIRE WEBSITE: their page state, scroll position, half-filled
   * forms and analytics session, all discarded because someone closed a chat.
   * A widget must never do that to the page hosting it. So tear our own state
   * down explicitly instead, and show the visitor where they are.
   *
   * `silent` skips the ended card for the nothing-to-lose case (never chatted),
   * going straight back to a fresh, usable chat.
   */
  function doReset(silent) {
    // Was there anything to restart? Read BEFORE the teardown below wipes both
    // signals (resetVisitorIdentity drops K.chatted; S.formDone is cleared with
    // the rest of the state). A visitor who never chatted has no previous
    // conversation, so flagging their FIRST message as a restart writes a
    // "Visitor started a new conversation" note on a thread that is not one.
    var hadSession = S.formDone || !!lsGet(K.chatted);
    // STOP EVERYTHING IN FLIGHT FIRST — a reset that only hides the UI leaves the
    // old session running behind it. A live recording is the worst of these: the
    // panel would hide the red pulse and its cancel button while the mic stayed
    // open, and the 5-minute cap would then auto-SEND that audio into the NEXT
    // conversation. Same reasoning as closePanel's guard.
    if (S.recording) stopRecord(false);
    ibar.style.display = ""; // showRecBar hid it; teardownRec may not have run yet
    if (vnCurrent) { try { vnCurrent.pause(); } catch (_e) {} vnCurrent = null; }
    if (S.readTimer) { clearTimeout(S.readTimer); S.readTimer = null; }
    if (S.typingClear) { clearTimeout(S.typingClear); S.typingClear = null; }
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    // Invalidate any parked flush chain so its send-timeout can't fire against the
    // new session (see flushGen).
    flushGen++;
    flushing = false;
    resetVisitorIdentity();
    // Tell the server the visitor ENDED — a disconnect alone is ambiguous (a
    // closed tab returns and reads what it missed), and without this the agent
    // keeps typing into a thread that can never reach anyone again. Emitted
    // BEFORE the disconnect, and the socket is torn down on a short delay so the
    // frame actually leaves the buffer; the UI below doesn't wait on it.
    if (S.socket) {
      var ending = S.socket;
      S.socket = null;
      try { ending.emit("visitor:end"); } catch (_e) {}
      setTimeout(function () { try { ending.disconnect(); } catch (_e) {} }, 250);
    }
    S.visitorId = newVisitorId();
    lsSet(K.visitor, S.visitorId);
    // The restart marker is only for the RELOAD path (boot reads it). In place we
    // carry the flag in memory, so a later refresh can't replay it.
    lsDel(K.restart);
    S.startedNew = hadSession;
    // Clear the conversation — "cleared on this device" is the promise the confirm
    // makes, and the privacy reason people end a chat on a shared computer.
    S.byId = {}; S.pending = {};
    S.lastGroup = null; S.lastDayLabel = null;
    S.viewInit = false; S.formDone = false; S.ready = false; S.closed = false;
    S.hasMore = false; S.oldestCursor = null; S.loadingOlder = false;
    S.preChat = null; S.typingOn = false; S.presenceSent = true;
    S.agentsOnline = undefined; S.retryDelay = 0;
    hideTyping(); clearReply(); clearStage(); clearUnread(); hideLoading();
    // Everything except the persistent "Load earlier" bar, which is ours.
    Array.prototype.slice.call(bodyEl.children).forEach(function (n) { if (n !== earlierBar) n.remove(); });
    showEarlier(false);
    ta.value = ""; autogrow(); updateSend();
    // clearUnread + the draft debounce write these back AFTER the wipe above.
    lsDel(K.seen); lsDel(K.draft);
    composer.style.display = "none";
    // A widget whose handshake is fatally rejected has nothing to restart into —
    // wiping the body would otherwise leave a blank panel with no explanation on
    // the very misconfiguration the installer is trying to diagnose.
    if (S.fatal) { appendSys("Chat is unavailable right now. Please try again later."); return; }
    if (silent) return startNewSession();
    setConn("idle");
    renderSessionEnded();
  }
  /** The end-of-session state: what happened, and the one way forward. */
  function renderSessionEnded() {
    if (bodyEl.querySelector(".ended")) return;
    bodyEl.appendChild(el("div", { class: "ended" }, [
      el("div", { class: "em" }, "Your chat session has ended."),
      el("button", { class: "cstart", type: "button", onclick: startNewSession }, "Start new chat session"),
    ]));
    scrollToBottom(true);
  }
  /** Reconnect under the new identity; `ready` + an empty `history` then rebuild
   *  the view (pre-chat form or welcome) exactly as a first-time visitor sees it. */
  function startNewSession() {
    bodyEl.querySelectorAll(".ended").forEach(function (n) { n.remove(); });
    showLoading();
    ensureConnected();
  }
  /** Inline, in-widget confirm — matches the widget's styling, works in the shadow
   *  DOM, and reads far less jarring than a native browser popup. */
  function showResetConfirm() {
    if (bodyEl.querySelector(".rconf")) return;
    var box = el("div", { class: "rconf" }, [
      el("div", { class: "rct" }, "End this chat? Your conversation is cleared on this device."),
      el("div", { class: "rca" }, [
        el("button", { class: "rcy", type: "button", onclick: function () { doReset(false); } }, "End chat"),
        el("button", { class: "rcn", type: "button", onclick: function () { box.remove(); } }, "Cancel"),
      ]),
    ]);
    bodyEl.appendChild(box); scrollIfStuck();
  }
  menuItem("End chat", requestReset);
  // Visitor-side mute for the notification chime — only offered when the org has
  // sounds on at all (shown/hidden in applyConfig).
  var muteItem = menuItem(lsGet(K.muted) === "1" ? "Unmute sounds" : "Mute sounds", function () {
    var muted = lsGet(K.muted) === "1";
    if (muted) lsDel(K.muted); else lsSet(K.muted, "1");
    muteItem.textContent = muted ? "Mute sounds" : "Unmute sounds";
  });
  muteItem.style.display = "none";
  var reStrip = el("div", { class: "restrip" }, "Reconnecting…"); panel.appendChild(reStrip);
  // Shown when no agent is online, so a visitor knows to expect a reply by email
  // rather than typing into silence (NN/g: if you're not staffed, say so).
  var awayBar = el("div", { class: "awaybar" }); panel.appendChild(awayBar);
  var bodyEl = el("div", { class: "body", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
  var newPill = el("button", { class: "newp" }, "↓ New messages");
  var dropEl = el("div", { class: "drop" }, "Drop to send");
  var toastEl = el("div", { class: "toast", role: "status" });
  var earlierBar = el("div", { class: "earlier" });
  var earlierBtn = el("button", { class: "earlierbtn", onclick: function () { loadOlder(); } }, "Load earlier messages");
  earlierBar.appendChild(earlierBtn); earlierBar.style.display = "none";
  bodyEl.appendChild(earlierBar);
  panel.appendChild(bodyEl);
  // Panel-anchored overlays (NOT in the scrolling body — see the .drop/.toast CSS note).
  panel.appendChild(dropEl);
  var replyBar = el("div", { class: "rc" }); var replyQt = el("div", { class: "qt" });
  replyBar.appendChild(el("span", null, "Reply:")); replyBar.appendChild(replyQt);
  replyBar.appendChild(el("button", { "aria-label": "Cancel reply", onclick: clearReply }, "✕"));
  panel.appendChild(replyBar);
  var fileInput = el("input", { type: "file", style: "display:none", "aria-hidden": "true" });
  var attachBtn = el("button", { class: "rbtn", "aria-label": "Attach a file", title: "Attach", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' });
  var ta = el("textarea", { rows: "1", placeholder: "Type a message…", "aria-label": "Message", dir: "auto" });
  var sendBtn = el("button", { class: "rbtn sbtn", "aria-label": "Send message", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' });
  var micBtn = el("button", { class: "rbtn", "aria-label": "Record a voice message", title: "Voice message", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>' });
  var emojiBtn = el("button", { class: "rbtn", type: "button", "aria-label": "Insert emoji", title: "Emoji", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>' });
  var EMOJIS = ["😀","😄","😂","😊","😍","😐","🙁","😢","📷","🎉","❤️","👌","👍","👎","🙏"];
  var emojiPop = el("div", { class: "emp", role: "menu" });
  EMOJIS.forEach(function (e) {
    emojiPop.appendChild(el("button", { class: "emo", type: "button", "aria-label": e, onclick: function () { insertAtCursor(ta, e); emojiPop.classList.remove("on"); } }, e));
  });
  emojiBtn.addEventListener("click", function (ev) { ev.stopPropagation(); emojiPop.classList.toggle("on"); if (emojiPop.classList.contains("on")) ta.focus(); });
  root.addEventListener("click", function () { emojiPop.classList.remove("on"); });
  var emojiWrap = el("div", { class: "emw" }, [emojiBtn, emojiPop]);
  var ibar = el("div", { class: "ibar" }, [attachBtn, emojiWrap, micBtn, ta, sendBtn]);
  // Staged attachment preview. Picking a file no longer sends it: it lands here so
  // the visitor can confirm they chose the right one and add a caption, matching
  // both the agent composer and every mainstream messenger.
  var stgThumb = el("span", { class: "ic" }, "📎");
  var stgName = el("div", { class: "nm" });
  var stgSize = el("div", { class: "sz" });
  var stgClear = el("button", { class: "x", type: "button", "aria-label": "Remove attachment", html: "&times;" });
  var stageEl = el("div", { class: "stg" }, [stgThumb, el("div", { class: "meta" }, [stgName, stgSize]), stgClear]);
  var composer = el("div", { class: "composer" }, [stageEl, ibar, fileInput]);
  // Pinned above the composer (not inside the scrolling body) so they stay put while
  // the visitor scrolls history — see the .newp CSS note.
  composer.appendChild(newPill);
  composer.appendChild(toastEl);
  // Hidden until the socket proves itself (`ready`/`history`) or the pre-chat
  // form is submitted. Previously it painted immediately while S.formDone was
  // still false, so onSend() returned early and a visitor typing into an
  // apparently-normal box got NOTHING — no bubble, no error, no queue. That is
  // exactly what an origin_not_allowed / unknown_site_key misconfiguration looks
  // like to the client. Once shown it stays shown, so the offline send queue on
  // a later disconnect is unaffected.
  composer.style.display = "none";
  panel.appendChild(composer);
  var footEl = el("div", { class: "foot" }); footEl.style.display = "none"; panel.appendChild(footEl);

  root.appendChild(panel); // panel stays inside the shadow root (keeps its styles)
  /**
   * Attach an inline embed to its container.
   *
   * Exposed as `CCPWebchat.mount(elOrSelector)` and retried by observer below,
   * because a ONE-SHOT `querySelector` at script time is wrong for the customers
   * most likely to use inline mode: a React/Next/Vue host mounts its container
   * after hydration, so the lookup missed, we logged a warning, and the widget
   * stayed invisible forever with no way to recover.
   */
  function mountInline(target) {
    var tgt = typeof target === "string" ? document.querySelector(target) : target;
    if (!tgt || !tgt.appendChild) return false;
    if (host.parentNode === tgt) return true;
    tgt.appendChild(host);
    // Undo the floating-mode pinning above (set with !important, so these must
    // be too) — inline embeds fill their container instead of the viewport.
    host.style.setProperty("position", "static", "important");
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("width", "100%", "important");
    host.style.setProperty("height", "100%", "important");
    root.classList.add("inl");
    return true;
  }
  if (INLINE && !mountInline(A.target)) {
    // Not in the DOM yet. Watch for it rather than giving up — bounded so we don't
    // leave an observer running forever on a page whose selector is simply a typo.
    var mo = null, moStop = null;
    var giveUp = function () {
      if (mo) { mo.disconnect(); mo = null; }
      if (moStop) { clearTimeout(moStop); moStop = null; }
    };
    try {
      mo = new MutationObserver(function () { if (mountInline(A.target)) giveUp(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      moStop = setTimeout(function () {
        giveUp();
        console.warn(
          "[webchat] target not found after 15s: " + A.target +
          " — check the selector, or call CCPWebchat.mount(element) once your container exists.",
        );
      }, 15000);
    } catch (_e) {
      console.warn("[webchat] target not found:", A.target);
    }
  }
  var lightbox = el("div", { class: "lb", "aria-hidden": "true" }); root.appendChild(lightbox);

  // ── open / close ───────────────────────────────────────────────────────────
  var lastFocus = null;
  // On-screen-keyboard fit (mobile, floating panel only). The panel is
  // position:fixed at 100dvh, but dvh tracks browser chrome — NOT the keyboard.
  // On iOS Safari the layout viewport doesn't shrink when the keyboard opens, so
  // the composer ends up underneath it and the visitor types blind. visualViewport
  // is the only accurate source for the visible area, so pin the panel to it while
  // open and hand the height back on close.
  var vv = window.visualViewport || null;
  function syncViewport() {
    if (!vv || !S.open) return;
    if (INLINE) {
      // An inline embed can't be pinned to the visual viewport — it lives inside
      // the host's layout and we must not fight their CSS. But on mobile the
      // software keyboard still covers the bottom of the page, and the composer is
      // at the bottom of our container, so the visitor types blind. Nudge the
      // composer back into the visible strip instead (the host page scrolls, we
      // don't resize anything). Only when the keyboard is actually up: vv.height
      // collapses well below the layout viewport when it opens.
      if (window.innerWidth <= 480 && vv.height < window.innerHeight * 0.75) {
        try { composer.scrollIntoView({ block: "end", behavior: "smooth" }); } catch (_e) {}
        scrollToBottom(false);
      }
      return;
    }
    // Desktop: hand sizing back to the visitor's dragged size (or the CSS default
    // when they've never resized). Blanket-clearing the height here silently undid
    // a restored size, because openPanel() calls this right after boot applies it.
    if (window.innerWidth > 480) { syncPanelSize(); return; }
    panel.style.height = vv.height + "px";
    scrollToBottom(false);
  }
  if (vv) { vv.addEventListener("resize", syncViewport); vv.addEventListener("scroll", syncViewport); }
  /**
   * Skeleton shown until `history` decides the real view (thread, welcome, or
   * pre-chat form).
   *
   * The panel restores OPEN across a refresh, so between first paint and the
   * socket's first frame the body is empty and the composer is hidden — a tall
   * white void. A one-line "Loading…" chip technically filled it but still read
   * as blank: a single muted string in a 500px column is an apology, not a state.
   * Placeholder rows in the shape of real messages read as "your conversation is
   * coming", occupy the space honestly, and — because the theme cache has already
   * painted the org's colours — arrive fully branded on the very first frame.
   *
   * Deliberately shaped like MESSAGES: the panel only auto-opens for someone who
   * left it open, which overwhelmingly means a returning visitor with a thread.
   */
  var loadEl = null;
  function showLoading() {
    if (loadEl || S.viewInit || S.fatal) return;
    loadEl = el("div", { class: "skel", "aria-hidden": "true" });
    // in / out / in — the rhythm of a real exchange, in descending prominence.
    [["in", 62], ["in", 44], ["out", 52]].forEach(function (row) {
      var side = row[0], w = row[1];
      var r = el("div", { class: "skrow " + side });
      if (side === "in") r.appendChild(el("div", { class: "skav" }));
      r.appendChild(el("div", { class: "skb", style: "width:" + w + "%" }));
      loadEl.appendChild(r);
    });
    bodyEl.appendChild(loadEl);
    // Announce it for screen readers, which can't see a shimmer.
    bodyEl.setAttribute("aria-busy", "true");
  }
  function hideLoading() {
    if (loadEl) { if (loadEl.parentNode) loadEl.parentNode.removeChild(loadEl); loadEl = null; }
    bodyEl.removeAttribute("aria-busy");
  }
  function openPanel() {
    if (INLINE) return;
    // Opening the chat is the moment a socket is actually needed (see boot()).
    // Reopening after ENDING one is a request to start again: connecting without
    // clearing the ended card left it sitting above a live welcome and composer.
    if (bodyEl.querySelector(".ended")) startNewSession();
    else ensureConnected();
    S.open = true; panel.classList.add("open"); requestAnimationFrame(function () { panel.classList.add("in"); });
    if (launcher) launcher.style.display = "none";
    showLoading();
    clearUnread(); if (S.formDone) setTimeout(function () { ta.focus(); }, 40); scrollToBottom(true); markRead();
    lsSet(K.open, "1");
    syncViewport();
  }
  function closePanel() {
    if (INLINE) return;
    // A recording must never outlive the visible panel: the red pulse is the only
    // indicator the mic is hot, and the 5-minute cap would otherwise auto-SEND
    // ambient audio recorded behind a closed chat. Closing cancels, never sends.
    if (S.recording) stopRecord(false);
    S.open = false; panel.classList.remove("in"); panel.classList.remove("open");
    panel.style.height = "";
    if (launcher) launcher.style.display = "flex";
    lsDel(K.open);
    if (lastFocus && lastFocus.focus) lastFocus.focus(); else if (launcher) launcher.focus();
  }
  if (launcher) launcher.addEventListener("click", function () { lastFocus = launcher; openPanel(); });
  closeBtn.addEventListener("click", closePanel);
  panel.addEventListener("keydown", function (e) {
    // Escape peels one layer at a time: an open popover closes first, the panel
    // only on the next press — losing the whole panel when you meant to dismiss
    // the emoji picker is a classic keyboard-user trap.
    if (e.key === "Escape" && (emojiPop.classList.contains("on") || menuEl.classList.contains("on"))) {
      e.preventDefault(); emojiPop.classList.remove("on"); closeMenu(); return;
    }
    if (e.key === "Escape" && !INLINE) { e.preventDefault(); closePanel(); return; }
    if (e.key === "Tab" && !INLINE) {
      var f = Array.prototype.filter.call(panel.querySelectorAll("button,textarea,input,a[href]"), function (x) { return x.offsetParent !== null; });
      if (!f.length) return; var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && shadow.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && shadow.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Public JS API (+ drain any pre-load queued calls).
  //
  // `mount` and `on` exist for host pages that build their own chrome around an
  // inline embed: `mount` hands us a container that didn't exist at script time
  // (an SPA route), and `on` lets them render their own unread badge or
  // "agent is typing" without reaching into the shadow root.
  var prior = window.CCPWebchat;
  var listeners = {};
  function emitApi(name, payload) {
    (listeners[name] || []).forEach(function (fn) { try { fn(payload); } catch (_e) {} });
  }
  window.CCPWebchat = {
    open: openPanel,
    close: closePanel,
    toggle: function () { S.open ? closePanel() : openPanel(); },
    isOpen: function () { return S.open; },
    /** Attach an inline embed to a container (element or selector). */
    mount: function (target) { return INLINE ? mountInline(target) : false; },
    /** Current unread count — for a host-rendered badge. */
    unreadCount: function () { return S.unread; },
    /** on("message"|"unread"|"ready"|"typing", fn) → unsubscribe function. */
    on: function (name, fn) {
      if (typeof fn !== "function") return function () {};
      (listeners[name] = listeners[name] || []).push(fn);
      return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); };
    },
  };
  if (prior && prior.q && prior.q.length) prior.q.forEach(function (c) { try { if (window.CCPWebchat[c[0]]) window.CCPWebchat[c[0]].apply(null, c[1] || []); } catch (_e) {} });

  // ── theming / config ────────────────────────────────────────────────────────
  /** First-ever visit: the launcher mounted hidden (no cached theme yet) and shows
   *  on the first applyConfig — or after this fallback, so a blocked/failed config
   *  fetch degrades to the default look rather than no widget at all. */
  function revealLauncher() { if (launcher) launcher.classList.remove("pre"); }
  setTimeout(revealLauncher, 2000);
  function applyConfig(payload, fromCache) {
    S.cfg = payload || {}; var cfg = (payload && payload.config) || {}, th = cfg.theme || {};
    var c = hex(th.primaryColor) || BRAND, lc = hex(th.launcherColor) || c, uc = hex(th.userBubbleColor) || c;
    root.style.setProperty("--c", c); root.style.setProperty("--ct", contrastOn(c));
    root.style.setProperty("--lc", lc); root.style.setProperty("--lct", contrastOn(lc));
    root.style.setProperty("--uc", uc); root.style.setProperty("--uct", contrastOn(uc));
    var font = cfg.fontFamily === "rounded" ? "'Nunito',ui-rounded,'Segoe UI',system-ui,sans-serif" : cfg.fontFamily === "serif" ? "Georgia,'Times New Roman',serif" : "";
    if (font) root.style.setProperty("--font", font); else root.style.removeProperty("--font");
    var dark = cfg.themeMode === "dark" || (cfg.themeMode === "auto" && (function () { try { return matchMedia("(prefers-color-scheme:dark)").matches; } catch (_e) { return false; } })());
    root.classList.toggle("dark", !!dark);
    var name = cfg.headerTitle || (payload && payload.name) || "Chat";
    titleEl.textContent = name;
    panel.setAttribute("aria-label", name);
    // BOTH branches rebuild the avatar box: the logo branch destroys the initials
    // text node, so a one-sided `else` that wrote to it mutated a DETACHED node —
    // removing a configured logo (now reachable via the cached-config path) left
    // the stale image up for the whole session.
    hava.innerHTML = "";
    if (cfg.logoDataUrl) hava.appendChild(el("img", { src: cfg.logoDataUrl, alt: "" }));
    else { havaInit = document.createTextNode(initials(name)); hava.appendChild(havaInit); }
    hava.appendChild(hdot);
    // Explicit else — a cached subtitle the org has since cleared must be undone.
    // Routed through the one owner so a config (re)apply can't overwrite a live
    // "Active now" with the static subtitle.
    paintHeaderStatus();
    if (cfg.showBranding !== false) { footEl.textContent = "Powered by Loadless"; footEl.style.display = ""; } else footEl.style.display = "none";
    // "Just chat" — hide the header on an embedded (inline / full-page) widget, so the
    // host page's own chrome frames it. Only for INLINE: a floating bubble needs its
    // header for the close/expand controls (a headerless mobile bubble would trap the
    // visitor with no way out).
    headerEl.style.display = INLINE && cfg.showHeader === false ? "none" : "";
    applyAttachmentPolicy();
    muteItem.style.display = cfg.soundEnabled ? "" : "none";
    // Persist what we just painted so the NEXT page load themes synchronously at
    // mount instead of flashing the default and re-painting when config arrives.
    // Skipped when unchanged (every reconnect), and the base64 logo/avatar are
    // stripped past ~256KB — this lives in the CUSTOMER site's storage quota.
    if (!fromCache && payload && payload.config) {
      var snap = JSON.stringify({ name: payload.name || "", config: cfg });
      if (snap.length > 262144) {
        var slim = {};
        for (var ck in cfg) if (ck !== "logoDataUrl" && ck !== "agentAvatarDataUrl") slim[ck] = cfg[ck];
        snap = JSON.stringify({ name: payload.name || "", config: slim });
      }
      if (snap !== lastThemeSnap) { lastThemeSnap = snap; lsSet(K.theme, snap); }
    }
    revealLauncher();
  }
  // Follow the OS light/dark switch live when themeMode is "auto" — applyConfig
  // only samples it once.
  try {
    matchMedia("(prefers-color-scheme:dark)").addEventListener("change", function (ev) {
      var cfg2 = (S.cfg && S.cfg.config) || {};
      if (cfg2.themeMode === "auto") root.classList.toggle("dark", ev.matches);
    });
  } catch (_e) {}
  function agentAvatar() { var cfg = (S.cfg && S.cfg.config) || {}; return cfg.agentAvatarDataUrl || null; }
  /** The business's display name — the header title, else the widget's own name. */
  function orgName() { var c = S.cfg || {}; return (c.config && c.config.headerTitle) || c.name || ""; }
  function onReady(payload) {
    S.ready = true; applyConfig(payload); emitApi("ready", { conversationId: (payload && payload.conversationId) || null });
    restoreDraft();
    // NOTE: the pre-chat form decision deliberately does NOT happen here. See
    // initView — `ready` always arrives BEFORE `history`, so at this point we
    // cannot yet know whether this visitor already has a conversation.
  }

  /**
   * Decide what the visitor sees: the pre-chat form, or the composer.
   *
   * Called from the FIRST `history` frame, never from `ready`. The server emits
   * `ready` and then `history` (both branches emit it — an empty array when there's
   * no conversation), so `history` is the earliest moment `S.byId` tells the truth.
   * Deciding in `onReady` meant `hasThread()` was ALWAYS false, so every returning
   * visitor was re-asked for their details and their existing thread then rendered
   * underneath the form. Re-asking for information already given is one of the
   * classic chat-UX failures, and it was happening on every page load.
   *
   * `S.viewInit` latches so a reconnect replay can't re-render the form mid-chat.
   */
  function initView(hasMessages) {
    if (S.viewInit) return; S.viewInit = true;
    hideLoading();
    var cfg = (S.cfg && S.cfg.config) || {};
    var fields = Array.isArray(cfg.preChatFields) ? cfg.preChatFields : [];
    // `K.prechat` covers the gap the message list can't: a visitor who completed the
    // form but hasn't sent anything yet has no messages, and must not be asked twice.
    if (fields.length && !hasMessages && lsGet(K.prechat) !== "1") renderForm(fields);
    else { S.formDone = true; composer.style.display = ""; if (!hasMessages) renderWelcome(); }
  }

  /**
   * Pre-chat form, asked ONE FIELD AT A TIME.
   *
   * The previous version stacked every field into a single card, which reads like a
   * signup wall standing between the visitor and help — the thing they came for.
   * Stepping it (with an "N of M" counter and Next) keeps each screen to a single
   * decision, which is the pattern every current chat product converged on. Answered
   * steps collapse to a compact summary line so the visitor can still see what
   * they've given without it sitting there as live inputs.
   *
   * Values live in `answers` rather than in the DOM, so Back can repopulate a field
   * after its input has been discarded.
   */
  function renderForm(fields) {
    composer.style.display = "none";
    var answers = new Array(fields.length);
    var step = 0;
    var card = el("div", { class: "form" });
    var title = el("h3", null, "Before we start");
    var sub = el("p", null, "A couple of quick details so we can help you faster.");
    var summary = el("div", { class: "fsum" });
    var fld = el("div", { class: "fld" });
    var errEl = el("div", { class: "err" }); errEl.style.display = "none";
    var backBtn = el("button", { class: "fback", type: "button" }, "Back");
    var counter = el("span", { class: "fcount" });
    var nextBtn = el("button", { class: "rbtn sbtn fnext" }, "Next");
    var nav = el("div", { class: "fnav" }, [backBtn, counter, nextBtn]);
    card.appendChild(title); card.appendChild(sub); card.appendChild(summary);
    card.appendChild(fld); card.appendChild(errEl); card.appendChild(nav);
    bodyEl.appendChild(card);

    function label(f) { return f.label + (f.required ? "" : " (optional)"); }
    /** Display text for a stored answer — resolves a select's option id to its name. */
    function answerLabel(f, v) {
      if (!Array.isArray(f.options)) return v;
      for (var i = 0; i < f.options.length; i++) if (f.options[i].id === v) return f.options[i].name;
      return v;
    }
    /** Validate the CURRENT step. Returns an error string, or "" when valid. */
    function validate(f, v) {
      if (f.required && !v) return "This field is required.";
      if (f.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "That email doesn't look right.";
      if (f.type === "phone" && v && !/^[+()\-\s\d]{6,}$/.test(v)) return "That phone number doesn't look right.";
      return "";
    }
    function commit() {
      var f = fields[step], inp = fld.querySelector("input,select"), v = (inp ? inp.value : "").trim();
      var err = validate(f, v);
      if (err) { errEl.textContent = err; errEl.style.display = ""; if (inp) inp.focus(); return false; }
      errEl.style.display = ""; errEl.style.display = "none";
      answers[step] = v;
      return true;
    }
    function finish() {
      var pre = {};
      fields.forEach(function (f, i) {
        var v = answers[i];
        // name/email/phone are identity fields; any OTHER type (a "text" field the
        // org added, e.g. "Company" or "Order number") is a CUSTOM contact field —
        // keyed by its label so the server can store it on the contact rather than
        // dropping it or overwriting the name.
        if (v) {
          if (f.type === "email") pre.email = v;
          else if (f.type === "phone") pre.phone = v;
          else if (f.type === "name") pre.name = v;
          // Keyed by the BOUND contact-field key when the admin picked one, so the
          // answer lands in that exact field. `f.label` is the legacy fallback for
          // widgets configured before the picker existed (the server slugifies it).
          else { pre.custom = pre.custom || {}; pre.custom[f.key || f.label] = v; }
        }
      });
      S.preChat = pre; S.formDone = true;
      // Remember it was completed: a visitor who submits but doesn't send a message
      // yet has no history for initView to infer this from.
      lsSet(K.prechat, "1");
      bodyEl.querySelectorAll(".form").forEach(function (n) { n.remove(); });
      composer.style.display = ""; renderWelcome(); ta.focus();
    }
    function paint() {
      var f = fields[step];
      // Everything answered so far, as one quiet line — context without clutter.
      summary.innerHTML = "";
      for (var i = 0; i < step; i++) {
        if (!answers[i]) continue;
        summary.appendChild(el("div", { class: "fsumrow" }, [
          el("span", { class: "k" }, fields[i].label),
          // A select answer is stored as the option ID (what the server needs) but
          // must READ as the option's name.
          el("span", { class: "v" }, answerLabel(fields[i], answers[i])),
        ]));
      }
      fld.innerHTML = "";
      // A question bound to a SELECT contact field is a CHOICE, not free text —
      // render its options (delivered live with the config) so the visitor can only
      // give an answer the field actually accepts. Typing into a text box here meant
      // an unrecognised answer resolved to nothing and was silently dropped.
      var opts = Array.isArray(f.options) ? f.options : null;
      var inp;
      if (opts && opts.length) {
        inp = el("select", { "aria-label": f.label });
        inp.appendChild(el("option", { value: "" }, f.required ? "Choose one…" : "Choose one… (optional)"));
        opts.forEach(function (o) { inp.appendChild(el("option", { value: o.id }, o.name)); });
        if (answers[step]) inp.value = answers[step];
      } else {
        inp = el("input", {
          type: f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text",
          placeholder: f.label,
          "aria-label": f.label,
          // Let the browser autofill do the typing — this is the visitor's own data.
          autocomplete: f.type === "email" ? "email" : f.type === "phone" ? "tel" : "name",
        });
      }
      if (answers[step]) {
        inp.value = answers[step];
      } else if (f.type === "phone") {
        // Default dial code so the country isn't dropped. Config override lets a
        // non-Lebanese org change it; "+961 " is the requested default.
        var cfg2 = (S.cfg && S.cfg.config) || {};
        var dial = (cfg2.phoneDialCode || "961").replace(/\D/g, "");
        inp.value = "+" + dial + " ";
      }
      fld.appendChild(el("label", null, label(f)));
      fld.appendChild(inp);
      errEl.style.display = "none";
      counter.textContent = (step + 1) + " of " + fields.length;
      backBtn.style.visibility = step === 0 ? "hidden" : "";
      var last = step === fields.length - 1;
      // An optional field a visitor hasn't filled offers Skip instead of Next, so
      // it's obvious they're allowed to move on.
      nextBtn.textContent = last ? "Start chat" : (!f.required && !inp.value ? "Skip" : "Next");
      inp.addEventListener("input", function () {
        errEl.style.display = "none";
        if (!last) nextBtn.textContent = !f.required && !inp.value ? "Skip" : "Next";
      });
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); advance(); }
      });
      inp.focus();
      if (inp.type === "tel" && inp.value) { try { var n = inp.value.length; inp.setSelectionRange(n, n); } catch (_e) {} }
    }
    function advance() {
      if (!commit()) return;
      if (step === fields.length - 1) return finish();
      step++; paint();
    }
    nextBtn.addEventListener("click", advance);
    backBtn.addEventListener("click", function () {
      if (step === 0) return;
      // Keep whatever is typed, even if invalid — Back must never destroy input.
      var inp = fld.querySelector("input,select");
      if (inp) answers[step] = inp.value.trim();
      step--; paint();
    });
    paint();
  }
  /** True once any message is rendered — used to suppress the welcome block. */
  function hasThread() { return Object.keys(S.byId).length > 0; }
  function renderWelcome() {
    if (hasThread()) return; var cfg = (S.cfg && S.cfg.config) || {};
    // The welcome is the COMPANY speaking, so it renders as a message from them —
    // avatar and all — not as a grey system chip. A centred chip reads as a
    // notice about the chat rather than the first line of it, which is why every
    // mainstream chat product uses a bubble here.
    if (cfg.welcomeMessage) {
      appendBubble({ direction: "out", body: cfg.welcomeMessage, status: "sent", createdAt: new Date().toISOString(), _local: true }, { anim: false });
    }
    var qs = Array.isArray(cfg.suggestedQuestions) ? cfg.suggestedQuestions : [];
    if (qs.length) { var p = el("div", { class: "pills" }); qs.forEach(function (q) { p.appendChild(el("button", { class: "pill", type: "button", onclick: function () { ta.value = q; onSend(); } }, q)); }); bodyEl.appendChild(p); }
  }
  function dropPills() { bodyEl.querySelectorAll(".pills").forEach(function (n) { n.remove(); }); }

  // ── rendering ────────────────────────────────────────────────────────────────
  function bubbleHtml(m) {
    if (m.deletedAt) return '<span style="opacity:.6;font-style:italic">This message was deleted</span>';
    var parts = [];
    // `data-rq` makes the quote a jump link to the quoted message, matching the
    // agent inbox (clicking a quote there scrolls to the original). Only set when
    // we know the id — a quote of a message older than the loaded window has
    // nothing to scroll to, and rendering it as clickable would dead-end.
    if (m.replyTo) { var q = m.replyTo.mediaKind ? "📎 " + m.replyTo.mediaKind : (m.replyTo.body || ""); parts.push('<div class="rq' + (m.replyTo.id ? " jump" : "") + '"' + (m.replyTo.id ? ' data-rq="' + esc(m.replyTo.id) + '"' : "") + ">" + esc(q).slice(0, 160) + "</div>"); }
    if (m.media && m.id) parts.push(mediaHtml(m));
    if (m.body) parts.push('<div dir="auto">' + linkify(m.body) + "</div>");
    return parts.join("");
  }
  var PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  var PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  /** Seconds → m:ss, for voice-note duration/elapsed. */
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
  }
  function mediaHtml(m) {
    var url = mediaUrl(m.id, false);
    // `sticker` is grouped with `image`: new webp uploads classify as `image`
    // (media-storage `classifyWebpAsImage`), but rows stored BEFORE that fix — and
    // any sticker forwarded from a Meta thread — still carry kind `sticker`. Absent
    // this branch they fell through to the document row, so a photo rendered as a
    // grey 📄 link.
    if (m.media.kind === "image" || m.media.kind === "sticker") return '<div class="media"><img src="' + url + '" alt="Photo" loading="lazy" data-full="' + url + '"></div>';
    if (m.media.kind === "video") return '<div class="media"><video src="' + url + '" controls preload="metadata"' + (m.media.hasThumbnail ? ' poster="' + mediaUrl(m.id, true) + '"' : "") + "></video></div>";
    if (m.media.kind === "audio") {
      // ALL audio uses the SAME purpose-built player. Native <audio controls> is
      // ~300px of chrome that, inside this panel, collapses into a useless ⋮ pill —
      // reported as broken for agent-sent audio files. A voice note is label-free;
      // a regular file shows its name above the scrubber.
      var dur = m.media.durationMs ? fmtDur(m.media.durationMs / 1000) : "";
      var nameRow = !m.media.voice && m.media.filename
        ? '<div class="vnname">' + esc(m.media.filename) + "</div>" : "";
      return '<div class="vn' + (m.media.voice ? "" : " afile") + '" data-src="' + url + '">' +
        '<button class="vnplay" type="button" aria-label="' + (m.media.voice ? "Play voice message" : "Play audio") + '">' + PLAY_SVG + "</button>" +
        '<div class="vnbar">' + nameRow + '<div class="vntrack"><i></i></div><span class="vntime">' + esc(dur) + "</span></div>" +
        "</div>";
    }
    return '<a class="doc" href="' + url + '&download=1" target="_blank" rel="noopener"><span class="ic">📄</span><span>' + esc(m.media.filename || m.media.kind || "file") + "</span></a>";
  }
  function tickHtml(s) {
    if (s === "read") return '<span class="tick read" title="Seen">✓✓</span>';
    if (s === "delivered") return '<span class="tick">✓✓</span>';
    if (s === "sent") return '<span class="tick">✓</span>';
    if (s === "queued" || s === "inflight") return '<span class="tick">🕓</span>';
    return "";
  }
  function metaHtml(m, isVisitor) { return esc(fmtTime(m.createdAt)) + (isVisitor ? " " + tickHtml(m.status) : ""); }
  // Build a message row element (no placement/grouping) — reused by append + prepend.
  // Author identity of an outbound row. AI replies group on their own key and get a
  // distinct label + avatar so a visitor always knows a bot answered (disclosure).
  function senderKeyOf(m) { return m.direction === "in" ? "v" : (m.ai ? "ai" : (m.senderName || "agent")); }
  function snameElOf(m, grouped) {
    if (m.direction === "in" || grouped) return null;
    if (m.ai) return el("div", { class: "sname", html: esc(m.senderName || "AI Assistant") + ' <span class="aib">AI</span>' });
    if (m.senderName) return el("div", { class: "sname" }, m.senderName);
    return null;
  }
  function mkRow(m, grouped, anim) {
    var isVisitor = m.direction === "in";
    var row = el("div", { class: "mr " + (isVisitor ? "out" : "in") + (grouped ? " grp" : "") });
    if (!isVisitor) {
      var av = el("div", { class: "av" + (m.ai ? " aiav" : "") }); var avImg = m.ai ? null : agentAvatar();
      if (avImg) av.appendChild(el("img", { src: avImg, alt: "" }));
      // Falls back to the ORG's initials, not a bullet: an agent message carries no
      // sender name whenever the workspace hides them (or for the welcome), and a
      // lone "•" beside every reply looks like a failed render.
      else av.appendChild(document.createTextNode(m.ai ? "AI" : initials(m.senderName || orgName())));
      row.appendChild(av);
    }
    // The rendered strings are kept on the row for upsert's no-change check —
    // reading them back via .innerHTML never matches (the serializer re-encodes
    // quotes differently than esc()), so every reconnect replay rebuilt media.
    var bh = bubbleHtml(m), mh = metaHtml(m, isVisitor);
    var bub = el("div", { class: "bubble" + (anim ? " anim" : ""), html: bh });
    var meta = el("div", { class: "meta", html: mh });
    row.appendChild(el("div", { class: "col" }, [bub, meta]));
    if (!m._local && m.externalId) row.appendChild(el("button", { class: "rep", title: "Reply", "aria-label": "Reply", onclick: function () { setReply(m); } }, "↩"));
    row._meta = meta; row._bub = bub; row._bubHtml = bh; row._metaHtml = mh;
    wireMedia(bub);
    if (m.id) { S.byId[m.id] = { el: row, msg: m }; trimHistory(); }
    return row;
  }
  function appendBubble(m, opts) {
    opts = opts || {};
    var isVisitor = m.direction === "in";
    var day = fmtDay(m.createdAt);
    if (S.lastDayLabel !== day) { bodyEl.appendChild(el("div", { class: "day" }, day)); S.lastDayLabel = day; }
    var senderKey = senderKeyOf(m);
    var grouped = S.lastGroup && S.lastGroup.sender === senderKey && S.lastGroup.day === day;
    var sn = snameElOf(m, grouped);
    if (sn) bodyEl.appendChild(sn);
    S.lastGroup = { sender: senderKey, day: day };
    var row = mkRow(m, grouped, !!opts.anim);
    bodyEl.appendChild(row);
    onNewRow(isVisitor);
    return row;
  }
  // "Load earlier" — prepend an older batch above the thread, preserving scroll.
  /**
   * Cap the rendered thread.
   *
   * `S.byId` held an entry per message, each pinning its DOM node, and nothing ever
   * evicted them — a visitor paging back through a long support thread grew the DOM
   * and the map monotonically for the life of the tab, degrading scroll and leaking
   * memory. Trim from the TOP (oldest) once we're comfortably past a screenful;
   * "Load earlier" re-fetches anything dropped, so nothing is lost. Only trims when
   * the visitor is near the bottom, so it can never yank content out from under
   * someone who is actively reading history.
   */
  var MAX_RENDERED = 250, TRIM_TO = 150;
  function trimHistory() {
    var ids = Object.keys(S.byId);
    if (ids.length <= MAX_RENDERED) return;
    var dist = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight;
    if (dist > 400) return; // reading older messages — leave the DOM alone
    var entries = ids
      .map(function (id) { return S.byId[id]; })
      .sort(function (a, b) { return new Date(a.msg.createdAt) - new Date(b.msg.createdAt); });
    entries.slice(0, ids.length - TRIM_TO).forEach(function (e) {
      if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
      delete S.byId[e.msg.id];
    });
    // Rewind the cursor to the oldest SURVIVING row — leaving it pointing below the
    // trimmed block made the next "Load earlier" fetch skip everything trimmed,
    // rendering a contiguous-looking thread with a silent gap.
    var oldestKept = entries[ids.length - TRIM_TO];
    if (oldestKept && oldestKept.msg.id) S.oldestCursor = { ts: oldestKept.msg.createdAt, id: oldestKept.msg.id };
    S.hasMore = true; showEarlier(true); // dropped rows are re-fetchable
  }
  function prependOlder(msgs) {
    if (!msgs.length) return;
    var anchor = null, kids = bodyEl.children;
    for (var i = 0; i < kids.length; i++) { var k = kids[i]; if (k !== newPill && k !== dropEl && k !== toastEl && k !== earlierBar) { anchor = k; break; } }
    var frag = document.createDocumentFragment(), grp = null;
    msgs.forEach(function (m) {
      var isVisitor = m.direction === "in", day = fmtDay(m.createdAt);
      if (!grp || grp.day !== day) frag.appendChild(el("div", { class: "day" }, day));
      var senderKey = senderKeyOf(m);
      var grouped = grp && grp.sender === senderKey && grp.day === day;
      var sn = snameElOf(m, grouped);
      if (sn) frag.appendChild(sn);
      grp = { sender: senderKey, day: day };
      frag.appendChild(mkRow(m, grouped, false));
    });
    // Anchor the viewport to the message the visitor was reading. `.body` sets
    // scroll-behavior:smooth, which makes an assignment to scrollTop ANIMATE — so
    // the restore visibly slid instead of holding position. Force an instant jump
    // for the restore, then hand smooth scrolling back.
    var prevH = bodyEl.scrollHeight, prevTop = bodyEl.scrollTop;
    var prevBehavior = bodyEl.style.scrollBehavior;
    bodyEl.style.scrollBehavior = "auto";
    bodyEl.insertBefore(frag, anchor);
    bodyEl.scrollTop = prevTop + (bodyEl.scrollHeight - prevH);
    bodyEl.style.scrollBehavior = prevBehavior || "";
  }
  function showEarlier(on) { earlierBar.style.display = on ? "" : "none"; }
  function loadOlder() {
    if (S.loadingOlder || !S.hasMore || !S.oldestCursor || !S.socket || !S.socket.connected) return;
    S.loadingOlder = true; earlierBtn.textContent = "Loading…"; earlierBtn.disabled = true;
    // The ack is the ONLY thing that re-arms the button — if it never fires (server
    // error mid-handler), "Load earlier" wedged on "Loading…" for the session.
    var settled = false;
    function rearm() { S.loadingOlder = false; earlierBtn.textContent = "Load earlier messages"; earlierBtn.disabled = false; }
    var lot = setTimeout(function () { if (!settled) { settled = true; rearm(); } }, 12000);
    S.socket.emit("visitor:loadOlder", { before: S.oldestCursor }, function (p) {
      if (settled) return;
      settled = true; clearTimeout(lot); rearm();
      var msgs = (p && p.messages) || [];
      if (msgs.length) { prependOlder(msgs); S.oldestCursor = { ts: msgs[0].createdAt, id: msgs[0].id }; }
      S.hasMore = !!(p && p.hasMore); showEarlier(S.hasMore);
    });
  }
  function appendSys(text) { bodyEl.appendChild(el("div", { class: "sys", dir: "auto" }, text)); }

  function upsert(m, quiet) {
    if (m.externalId) for (var cid in S.pending) { if (m.externalId.slice(-cid.length) === cid) { removePending(cid); break; } }
    // Re-render only what actually CHANGED. The server replays history on every
    // reconnect (and mobile tabs reconnect constantly on wake/network flap), so
    // unconditionally reassigning innerHTML rebuilt every <img>/<video>/<audio> in
    // the thread — re-downloading images and cutting off a voice note or video
    // mid-playback. Comparing the rendered string first makes a redundant replay
    // a no-op, which is the common case.
    if (m.id && S.byId[m.id]) {
      var e = S.byId[m.id]; e.msg = m;
      // Compare against the STORED render string, not .innerHTML — the serializer
      // re-encodes quotes/apostrophes differently than esc(), so reading it back
      // never matched for such bodies and every replay rebuilt the media anyway.
      if (e.el._bub) { var h = bubbleHtml(m); if (e.el._bubHtml !== h) { e.el._bubHtml = h; e.el._bub.innerHTML = h; wireMedia(e.el._bub); } }
      if (e.el._meta) { var mh = metaHtml(m, m.direction === "in"); if (e.el._metaHtml !== mh) { e.el._metaHtml = mh; e.el._meta.innerHTML = mh; } }
      return;
    }
    appendBubble(m, { anim: !quiet });
    // Viewing it live counts as reading it — stamp the seen watermark too, or the
    // next boot's history replay re-counts this message as unread (phantom badge).
    if (!quiet && m.direction === "out") { hideTyping(); if (S.socket && S.socket.connected) S.socket.emit("visitor:received"); if (!S.open || document.hidden) { bumpUnread(); playPing(); } else { markRead(); clearUnread(); } }
    // Host-page hook. `quiet` marks a history replay, so a host badge doesn't
    // re-fire for messages the visitor already saw on a reconnect.
    if (!quiet) emitApi("message", { direction: m.direction, body: m.body, hasMedia: !!m.media, createdAt: m.createdAt });
  }
  function applyStatus(id, s) { var e = S.byId[id]; if (e) { e.msg.status = s; if (e.msg.direction === "in" && e.el._meta) { e.el._metaHtml = metaHtml(e.msg, true); e.el._meta.innerHTML = e.el._metaHtml; } } }

  function wireMedia(bub) {
    if (!bub) return;
    bub.querySelectorAll("img[data-full]").forEach(function (img) {
      img.onclick = function () { openLightbox(img.getAttribute("data-full")); };
      // An image has NO height until it decodes, so the scroll fired when its bubble
      // was appended landed ABOVE it — the reported "sending an image doesn't scroll
      // to bottom". Re-scroll once the real height is known, on the NEXT frame so
      // layout has settled (a tall image can grow 200px+, and scrolling in the load
      // handler synchronously used the pre-layout height). When this image is in the
      // LAST message we FORCE the scroll — a just-sent/just-arrived image at the
      // bottom must always be fully visible, even if the growth pushed us past the
      // stick threshold.
      var onReady = function () {
        requestAnimationFrame(function () {
          var rows = bodyEl.querySelectorAll(".mr");
          var isLast = rows.length > 0 && rows[rows.length - 1] === bub.closest(".mr");
          scrollToBottom(isLast || S.stick);
        });
      };
      if (img.complete && img.naturalHeight) onReady();
      else { img.addEventListener("load", onReady, { once: true }); img.addEventListener("error", onReady, { once: true }); }
    });
    bub.querySelectorAll(".vn").forEach(wireVoiceNote);
  }

  /**
   * Behaviour for one voice-note bubble.
   *
   * The <audio> element is created on FIRST PLAY, not at render: a thread with 20
   * voice notes would otherwise instantiate 20 media elements, and `preload` alone
   * doesn't stop the browser reserving decoder resources for each. Only one plays at
   * a time — starting a second pauses the first, which is what every messenger does
   * and avoids two voices talking over each other.
   */
  var vnCurrent = null;
  function wireVoiceNote(root) {
    if (root._wired) return; root._wired = true;
    var btn = root.querySelector(".vnplay");
    var track = root.querySelector(".vntrack");
    var fill = track.querySelector("i");
    var timeEl = root.querySelector(".vntime");
    var total = timeEl.textContent; // server-provided duration, shown until we know better
    var audio = null;

    function paint() {
      if (!audio || !isFinite(audio.duration) || !audio.duration) return;
      fill.style.width = (audio.currentTime / audio.duration) * 100 + "%";
      timeEl.textContent = fmtDur(audio.currentTime) + " / " + fmtDur(audio.duration);
    }
    function stopOthers() { if (vnCurrent && vnCurrent !== audio) { try { vnCurrent.pause(); } catch (_e) {} } }
    function ensure() {
      if (audio) return audio;
      audio = new Audio(root.getAttribute("data-src"));
      audio.preload = "metadata";
      audio.addEventListener("timeupdate", paint);
      audio.addEventListener("loadedmetadata", paint);
      audio.addEventListener("play", function () { stopOthers(); vnCurrent = audio; btn.innerHTML = PAUSE_SVG; root.classList.add("on"); });
      audio.addEventListener("pause", function () { btn.innerHTML = PLAY_SVG; root.classList.remove("on"); });
      audio.addEventListener("ended", function () {
        btn.innerHTML = PLAY_SVG; root.classList.remove("on");
        fill.style.width = "0%"; timeEl.textContent = total; audio.currentTime = 0;
      });
      audio.addEventListener("error", function () { timeEl.textContent = "Unavailable"; btn.disabled = true; });
      return audio;
    }
    btn.addEventListener("click", function () {
      var a = ensure();
      if (a.paused) { a.play().catch(function () { timeEl.textContent = "Unavailable"; }); }
      else a.pause();
    });
    // Scrub. Pointer events cover mouse and touch with one path, and capture keeps
    // the drag alive when the finger leaves the 4px-tall track.
    function seekTo(clientX) {
      var a = ensure();
      if (!isFinite(a.duration) || !a.duration) return;
      var r = track.getBoundingClientRect();
      a.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * a.duration;
      paint();
    }
    var dragging = false;
    track.addEventListener("pointerdown", function (e) { dragging = true; try { track.setPointerCapture(e.pointerId); } catch (_e) {} seekTo(e.clientX); });
    track.addEventListener("pointermove", function (e) { if (dragging) seekTo(e.clientX); });
    track.addEventListener("pointerup", function () { dragging = false; });
    track.addEventListener("pointercancel", function () { dragging = false; });
  }
  function openLightbox(url) { lightbox.innerHTML = ""; lightbox.appendChild(el("img", { src: url, alt: "Photo" })); lightbox.classList.add("on"); }
  lightbox.addEventListener("click", function () { lightbox.classList.remove("on"); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && lightbox.classList.contains("on")) lightbox.classList.remove("on"); });

  // ── scroll + unread ─────────────────────────────────────────────────────────
  // Auto-load older history only on a genuine UPWARD scroll.
  //
  // The naive "scrollTop < 48" test fires on scroll events the visitor never
  // caused. While the panel is hidden the body has zero height, so scrollTop
  // sits at 0; the scroll events emitted as it opens and snaps to the bottom
  // are read as "already at the top" and immediately pull a second history
  // page. Every open fetched 100 messages instead of 50 and rendered
  // backlog the visitor hadn't asked for.
  //
  // Comparing against the previous position makes intent explicit: opening and
  // snapping to the bottom moves DOWN, and prependOlder restores position
  // downward too, so neither can trigger a fetch. A thread too short to
  // overflow never scrolls at all and simply keeps the "Load earlier" button.
  var lastScrollTop = 0;
  // Click a reply quote → scroll to the quoted message and flash it. Delegated so
  // it keeps working across re-renders and history prepends (bubbles are rebuilt
  // by `upsert`, so a per-node listener would be lost).
  bodyEl.addEventListener("animationend", function (e) {
    var t = e.target;
    if (t && t.classList) { t.classList.remove("anim"); t.classList.remove("flash"); }
  });
  bodyEl.addEventListener("click", function (e) {
    var q = e.target && e.target.closest ? e.target.closest(".rq.jump") : null;
    if (!q) return;
    var entry = S.byId[q.getAttribute("data-rq")];
    if (!entry || !entry.el) {
      // Quoted message is older than the loaded window — say so instead of doing
      // nothing, which reads as a broken click.
      return toast("That message is further up — use “Load earlier messages”.");
    }
    entry.el.scrollIntoView({ block: "center", behavior: "smooth" });
    var bub = entry.el.querySelector(".mr") || entry.el;
    bub.classList.remove("flash");
    void bub.offsetWidth; // restart the animation if the same target is re-clicked
    bub.classList.add("flash");
  });
  bodyEl.addEventListener("scroll", function () {
    var top = bodyEl.scrollTop;
    var scrolledUp = top < lastScrollTop;
    lastScrollTop = top;
    S.stick = bodyEl.scrollHeight - top - bodyEl.clientHeight < 90;
    if (S.stick) newPill.classList.remove("on");
    if (scrolledUp && top < 48 && S.hasMore && !S.loadingOlder) loadOlder();
  });
  newPill.addEventListener("click", function () { S.stick = true; scrollToBottom(true); });
  function scrollToBottom(force) {
    if (!(force || S.stick)) return;
    // `.body` scrolls smoothly, which is right for a one-message nudge — but a big
    // jump (opening the panel onto history) animated a "fly-through" of the whole
    // thread. Big jumps snap instantly, same trick as prependOlder's restore.
    var dist = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight;
    if (dist > 600) {
      var pb = bodyEl.style.scrollBehavior;
      bodyEl.style.scrollBehavior = "auto";
      bodyEl.scrollTop = bodyEl.scrollHeight;
      bodyEl.style.scrollBehavior = pb || "";
    } else bodyEl.scrollTop = bodyEl.scrollHeight;
    newPill.classList.remove("on");
  }
  function onNewRow(isVisitor) { if (isVisitor || S.stick) scrollToBottom(true); else newPill.classList.add("on"); }
  /** Scroll to bottom only if already stuck there — for typing/system rows that
   *  must NEVER raise the "New messages" pill. */
  function scrollIfStuck() { if (S.stick) scrollToBottom(true); }
  function bumpUnread() { S.unread++; if (badge) { badge.textContent = S.unread > 9 ? "9+" : String(S.unread); badge.classList.add("on"); } flashTitle(); emitApi("unread", S.unread); }
  function clearUnread() { S.unread = 0; if (badge) badge.classList.remove("on"); S.lastSeenTs = Date.now(); lsSet(K.seen, String(S.lastSeenTs)); stopFlash(); emitApi("unread", 0); }
  // Capture the title when the flash STARTS, not at script load. On a React/Next/Vue
  // host that retitles on route change, restoring a load-time snapshot reverted the
  // customer's page title to a stale value — and it never recovered.
  function flashTitle() {
    if (titleTimer || !document.hidden) return;
    baseTitle = document.title;
    var on = false;
    titleTimer = setInterval(function () { document.title = (on = !on) ? "💬 New message" : baseTitle; }, 1000);
  }
  function stopFlash() { if (titleTimer) { clearInterval(titleTimer); titleTimer = null; document.title = baseTitle; } }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { stopFlash(); if (S.open) { clearUnread(); markRead(); } }
    emitPresence();
  });
  /**
   * Tell the agents whether the visitor is actually LOOKING at the page.
   *
   * A backgrounded tab keeps its socket open, so connect/disconnect alone made the
   * inbox show "Online" for someone who had switched away. One tiny frame per real
   * tab switch (deduped on change) feeds the server's existing presence seam.
   */
  function emitPresence() {
    var visible = !document.hidden;
    if (!S.socket || !S.socket.connected || visible === S.presenceSent) return;
    S.presenceSent = visible;
    S.socket.emit("visitor:presence", { visible: visible });
  }

  // ── reply ────────────────────────────────────────────────────────────────────
  function setReply(m) { S.replyTo = { externalId: m.externalId, body: m.media ? (m.media.kind || "attachment") : m.body }; replyQt.textContent = S.replyTo.body || ""; replyBar.classList.add("on"); ta.focus(); }
  function clearReply() { S.replyTo = null; replyBar.classList.remove("on"); }

  var toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("on"); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove("on"); }, 3200); }

  // ── composer ─────────────────────────────────────────────────────────────────
  function insertAtCursor(el2, text) {
    var start = el2.selectionStart == null ? el2.value.length : el2.selectionStart;
    var end = el2.selectionEnd == null ? el2.value.length : el2.selectionEnd;
    el2.value = el2.value.slice(0, start) + text + el2.value.slice(end);
    var pos = start + text.length;
    try { el2.setSelectionRange(pos, pos); } catch (_e) {}
    el2.focus(); el2.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function autogrow() { ta.style.height = "auto"; var h = Math.min(ta.scrollHeight, 112); ta.style.height = h + "px"; ta.style.overflowY = ta.scrollHeight > 112 ? "auto" : "hidden"; }
  // Send is live when there's text OR a staged attachment (a file with no caption
  // is a perfectly normal message).
  function updateSend() { sendBtn.disabled = !ta.value.trim() && !S.staged; }
  function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
  /** Put a picked file in the staging chip. Nothing is uploaded until send. */
  function stageFile(file) {
    if (!S.formDone) return;
    if (file.size > MAX_BYTES) return toast("File is too large (max 25 MB).");
    if (file.type && !OK_MIME.test(baseMime(file.type))) return toast("That file type isn't supported.");
    var k0 = (file.type || "").split("/")[0];
    k0 = k0 === "image" || k0 === "video" || k0 === "audio" ? k0 : "document";
    if (!kindAllowed(k0)) {
      var human = { image: "Images", video: "Videos", audio: "Audio files", document: "Documents" }[k0] || "Those files";
      return toast(human + " aren't accepted in this chat.");
    }
    clearStage();
    var kind = (file.type || "").split("/")[0];
    kind = kind === "image" || kind === "video" || kind === "audio" ? kind : "document";
    S.staged = { file: file, kind: kind, name: file.name || "attachment" };
    stgName.textContent = S.staged.name;
    stgSize.textContent = fmtSize(file.size);
    // Thumbnail for images; an objectURL we must revoke on clear so the blob isn't
    // pinned in memory for the life of the tab.
    if (kind === "image") {
      var url = URL.createObjectURL(file);
      S.staged.preview = url;
      var img = el("img", { src: url, alt: "" });
      stageEl.replaceChild(img, stgThumb); stgThumb = img;
    } else {
      var ic = el("span", { class: "ic" }, kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "📄");
      stageEl.replaceChild(ic, stgThumb); stgThumb = ic;
    }
    stageEl.classList.add("on"); updateSend(); ta.focus();
  }
  function clearStage() {
    if (S.staged && S.staged.preview) URL.revokeObjectURL(S.staged.preview);
    S.staged = null; stageEl.classList.remove("on"); updateSend();
  }
  var draftTimer = null;
  ta.addEventListener("input", function () { autogrow(); updateSend(); if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(function () { lsSet(K.draft, JSON.stringify({ t: Date.now(), v: ta.value })); }, 300); });
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } });
  ta.addEventListener("focus", function () { ibar.classList.add("focus"); });
  ta.addEventListener("blur", function () { ibar.classList.remove("focus"); });
  sendBtn.addEventListener("click", onSend);
  attachBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () { var f = fileInput.files && fileInput.files[0]; fileInput.value = ""; if (f) stageFile(f); });
  stgClear.addEventListener("click", clearStage);
  function restoreDraft() {
    var raw = lsGet(K.draft); if (!raw) return;
    var text = "";
    try { var o = JSON.parse(raw); if (o && typeof o === "object") { if (!isFresh(o.t)) { lsDel(K.draft); return; } text = o.v || ""; } else { text = raw; } }
    catch (_e) { text = raw; } // legacy bare-string draft
    if (text) { ta.value = text; autogrow(); updateSend(); }
  }
  updateSend();

  // ── outbox ────────────────────────────────────────────────────────────────────
  // "inflight" is persisted AS "queued": the frame was emitted but not yet acked,
  // so a refresh/tab-kill inside the SEND_TIMEOUT window would otherwise drop it
  // from both the UI and storage with no trace (the mobile-flap case). Re-flushing
  // it on next boot is safe — the server dedupes on
  // externalId = widget:visitor:clientMsgId, and retries reuse the same cid.
  function persistOutbox() { var arr = []; for (var cid in S.pending) { var p = S.pending[cid]; if (p.file) continue; if (p.status === "queued" || p.status === "failed" || p.status === "inflight") arr.push({ cid: cid, payload: p.payload, status: p.status === "failed" ? "failed" : "queued", ts: p.ts }); } if (arr.length) lsSet(K.outbox, JSON.stringify(arr)); else lsDel(K.outbox); }
  function restoreOutbox() { var raw = lsGet(K.outbox); if (!raw) return; var arr; try { arr = JSON.parse(raw); } catch (_e) { return; } (arr || []).forEach(function (it) { if (it && it.cid && it.payload && (it.ts == null || isFresh(it.ts))) optimistic(it.cid, it.payload, null, it.status === "failed" ? "failed" : "queued"); }); }

  // ── attachment store (IndexedDB) ──────────────────────────────────────────────
  // A QUEUED attachment cannot ride in the localStorage outbox: a File isn't JSON,
  // so `persistOutbox` skips it (`if (p.file) continue`). That meant a refresh while
  // an upload was queued (offline) or failed made the visitor's file vanish — bubble
  // gone, no error, nothing to retry. Silent data loss is the worst failure mode in
  // the widget, so blobs live here instead, keyed by clientMsgId, and are deleted
  // the instant the upload succeeds (after which the outbox row is plain JSON and
  // localStorage carries it as usual).
  //
  // Every call is best-effort and individually guarded: Safari private mode and
  // some embedded webviews throw on `indexedDB.open`, and a widget must degrade to
  // today's behaviour rather than break the chat.
  var IDB_STORE = "files";
  // One connection for the tab, so `deleteDatabase` has exactly one thing to close
  // (see resetVisitorIdentity) instead of a new handle per operation.
  var idbConn = null;
  function idbClose() { if (idbConn) { try { idbConn.close(); } catch (_e) {} idbConn = null; } }
  function idb(cb) {
    if (idbConn) return cb(idbConn);
    var req;
    try { req = indexedDB.open("ccp_wc_" + siteKey, 1); } catch (_e) { return cb(null); }
    req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (_e) {} };
    req.onsuccess = function () { idbConn = req.result; cb(idbConn); };
    req.onerror = function () { cb(null); };
    req.onblocked = function () { cb(null); };
  }
  function idbPut(cid, rec) { idb(function (db) { if (!db) return; try { db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(rec, cid); } catch (_e) {} }); }
  function idbDel(cid) { idb(function (db) { if (!db) return; try { db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(cid); } catch (_e) {} }); }
  /** Re-hydrate queued attachments into pending bubbles, then flush if we're live. */
  function restoreAttachments() {
    idb(function (db) {
      if (!db) return;
      var store, keysReq, valsReq;
      try {
        store = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
        keysReq = store.getAllKeys(); valsReq = store.getAll();
      } catch (_e) { return; }
      valsReq.onsuccess = function () {
        var keys = keysReq.result || [], vals = valsReq.result || [];
        for (var i = 0; i < keys.length; i++) {
          var cid = keys[i], rec = vals[i];
          if (!rec || !rec.blob || S.pending[cid]) continue;
          var recTs = (rec.payload && rec.payload.clientTs) || new Date(rec.createdAt || 0).getTime();
          if (!isFresh(recTs)) { idbDel(cid); continue; } // stale queued file — drop it, don't retry days later
          var m = { direction: "in", body: rec.voice ? "🎤 Voice message" : "📎 " + (KIND_LABEL[rec.kind] || "File"), media: null, status: "queued", createdAt: rec.createdAt || new Date().toISOString(), _local: true };
          var row = appendBubble(m, { anim: false });
          S.pending[cid] = { el: row, payload: rec.payload || { clientMsgId: cid, body: "" }, status: "queued", file: rec.blob, fileName: rec.name, kind: rec.kind, voice: rec.voice, durationMs: rec.durationMs, ts: (rec.payload && rec.payload.clientTs) || new Date(rec.createdAt || Date.now()).getTime() };
          renderPending(cid);
        }
        // IndexedDB is async, so boot()'s synchronous `hasQueued` check has already
        // run by now. Connecting here is what actually gets a recovered attachment
        // delivered — the socket's own `connect` handler calls flushOutbox().
        if (keys.length) { ensureConnected(); flushOutbox(); }
      };
    });
  }
  function optimistic(cid, payload, file, status) {
    var m = { direction: "in", body: payload.body || "", media: null, status: status || "queued", createdAt: new Date().toISOString(), replyTo: payload.replyToExternalId ? { body: (S.replyTo && S.replyTo.body) || "" } : null, _local: true };
    var row = appendBubble(m, { anim: true }); S.pending[cid] = { el: row, payload: payload, status: status || "queued", file: file || null, ts: payload.clientTs || Date.now() }; renderPending(cid); return row;
  }
  function renderPending(cid) {
    // Timestamp is when the visitor WROTE it (p.ts), not the current repaint time —
    // a restored queued bubble was re-stamping itself with "now" on every boot.
    var p = S.pending[cid]; if (!p || !p.el._meta) return; var meta = p.el._meta;
    var when = esc(fmtTime(p.ts || undefined));
    if (p.status === "failed") {
      meta.innerHTML = when + ' <span class="tick err">⚠</span> ';
      meta.appendChild(el("span", { class: "retry", onclick: function () { retry(cid); } }, "Retry"));
      // A frozen progress bar under ⚠ Retry reads as still-uploading — drop it.
      if (p._prog) { if (p._prog.parentNode) p._prog.parentNode.removeChild(p._prog); p._prog = null; }
    } else meta.innerHTML = when + " " + tickHtml(p.status);
    if (p.file && (p.status === "queued" || p.status === "inflight") && !p._prog) { p._prog = el("div", { class: "prog" }, el("i")); p.el._bub.appendChild(p._prog); }
  }
  /** Move pending (unsent/queued) bubbles BELOW whatever just rendered — history
   *  and the welcome block arrive after boot's outbox restore, so without this the
   *  visitor's newest unsent message sat pinned above the whole thread. */
  function resortPending() {
    Object.keys(S.pending)
      .sort(function (a, b) { return (S.pending[a].ts || 0) - (S.pending[b].ts || 0); })
      .forEach(function (cid) { var p = S.pending[cid]; if (p.el && p.el.parentNode === bodyEl) bodyEl.appendChild(p.el); });
  }
  function removePending(cid) { var p = S.pending[cid]; if (!p) return; if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el); delete S.pending[cid]; idbDel(cid); persistOutbox(); }
  function markPending(cid, s) { var p = S.pending[cid]; if (!p) return; p.status = s; renderPending(cid); persistOutbox(); }
  // Flush SERIALLY, oldest first. Firing every queued message in parallel let them
  // race: whichever ingest committed first won, so three messages typed offline
  // could reach the agent shuffled. `clientTs` (stamped at compose time, honoured
  // by the server within a 24h window) fixes the recorded ORDER; sending one at a
  // time keeps the wire order matching too. Also re-arms "inflight" items: a send
  // interrupted by the disconnect would otherwise sit untouched until its 12s
  // SEND_TIMEOUT expired, stalling a reconnect that already happened.
  var flushing = false;
  // Bumped whenever a chain is abandoned (disconnect, session reset). A timeout
  // parked from an older chain would otherwise mark a message the RECONNECT
  // already delivered as failed, and then resume sending alongside the new chain.
  var flushGen = 0;
  function flushOutbox() {
    if (flushing || !S.socket || !S.socket.connected) return;
    var cids = Object.keys(S.pending)
      .filter(function (cid) { var s = S.pending[cid].status; return s === "queued" || s === "inflight"; })
      .sort(function (a, b) { return (S.pending[a].ts || 0) - (S.pending[b].ts || 0); });
    if (!cids.length) return;
    flushing = true;
    var gen = ++flushGen;
    var i = 0;
    var next = function () {
      if (gen !== flushGen) return; // superseded — a newer chain owns the queue
      if (i >= cids.length || !S.socket || !S.socket.connected) { flushing = false; return; }
      var cid = cids[i++], p = S.pending[cid];
      if (!p) return next();
      if (p.file) { doUpload(cid, next); return; }
      sendPayload(cid, next, gen);
    };
    next();
  }
  function sendPayload(cid, after, gen) {
    var p = S.pending[cid]; if (!p) return after && after();
    markPending(cid, "inflight");
    var settled = false, advanced = false;
    var go = function () { if (!advanced) { advanced = true; if (after) after(); } };
    var timer = setTimeout(function () {
      // A chain the socket abandoned must not flip a message the reconnect
      // already delivered back to "failed".
      if (settled || (gen !== undefined && gen !== flushGen)) return;
      // Timed out — surface Retry and let the queue move on, but do NOT mark this
      // resolved: a late ack below can still arrive and correct the bubble.
      markPending(cid, "failed"); go();
    }, SEND_TIMEOUT);
    S.socket.emit("visitor:message", p.payload, function (ack) {
      // Accept a LATE ack. Previously the timeout set `done` and this callback
      // returned early, so a message the server had accepted kept showing ⚠ Retry —
      // telling the visitor their message failed when it hadn't. Retrying was
      // harmless (same clientMsgId, server dedupes) but the state was a lie.
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (ack && ack.ok === false) {
        markPending(cid, "failed");
        toast(ack.error === "rate_limited" ? "You're sending too fast — try again in a moment." : "Message failed to send.");
      } else markPending(cid, "sent");
      go();
    });
  }
  function retry(cid) { var p = S.pending[cid]; if (!p) return; markPending(cid, "queued"); if (p.file) doUpload(cid); else sendPayload(cid); }
  function onSend() {
    if (!S.formDone) return; var text = ta.value.replace(/\s+$/, "");
    // A staged attachment sends with whatever text is in the box as its caption.
    if (S.staged) { var st = S.staged; S.staged = null; stageEl.classList.remove("on"); ta.value = ""; autogrow(); updateSend(); lsDel(K.draft); dropPills(); emitTyping(false); uploadFile(st.file, { caption: text, staged: st }); return; }
    if (!text.trim()) return;
    ta.value = ""; autogrow(); updateSend(); lsDel(K.draft); dropPills(); emitTyping(false);
    var cid = newCid();
    // clientTs = when the visitor TYPED it. For a message that queues offline this
    // is what preserves order in the agent inbox; the server clamps it (see
    // resolveClientTimestamp) so a skewed clock can't hijack the sort.
    var payload = { clientMsgId: cid, body: text.slice(0, 4096), clientTs: Date.now() };
    if (S.replyTo) payload.replyToExternalId = S.replyTo.externalId;
    if (S.preChat) { payload.preChat = S.preChat; S.preChat = null; }
    if (S.startedNew) { payload.startedNew = true; S.startedNew = false; }
    if (S.closed) { S.closed = false; bodyEl.querySelectorAll(".sys.closed").forEach(function (n) { n.remove(); }); }
    // Remember that this visitor has a thread, so future page loads connect eagerly
    // and agent replies still reach them without opening the panel first.
    lsSet(K.chatted, "1"); lsSet(K.active, String(Date.now()));
    // Optimistic bubble FIRST — it reads S.replyTo for the quote stripe, so
    // clearing the reply before it rendered an empty quote on every reply.
    optimistic(cid, payload, null, "queued"); clearReply(); ensureConnected(); persistOutbox(); flushOutbox();
  }

  // ── media ─────────────────────────────────────────────────────────────────────
  // MUST stay in step with the server's ALLOWED_MIME_BY_KIND
  // (apps/api/src/lib/blob-storage/mime-guard.ts). Drift is invisible in testing
  // and awful in production: a type the client allows but the server refuses
  // uploads and then fails with a bare "Upload failed.", while a type the server
  // allows but the client refuses never leaves the browser. Notably `audio/x-m4a`
  // — Chrome and Safari report .m4a files as that, so omitting it rejected every
  // .m4a with "That file type isn't supported". `application/zip` is deliberately
  // absent from BOTH sides.
  var OK_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime|3gpp)|audio\/(mpeg|mp4|ogg|wav|x-wav|webm|aac|x-m4a|amr|opus)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument.*|vnd\.ms-excel|vnd\.ms-powerpoint))$/i;
  /**
   * The organization's attachment policy, from config. Absent = everything allowed.
   *
   * This is the COURTESY half — hiding a button the visitor can't use, and failing
   * fast with a clear message instead of after a wasted upload. The real control is
   * server-side (`widgetAllowsMediaKind` on the upload endpoint); a widget running
   * on someone else's page can never be the enforcement point.
   */
  function allowedKinds() {
    var cfg = (S.cfg && S.cfg.config) || {};
    return Array.isArray(cfg.allowedMediaKinds) ? cfg.allowedMediaKinds : null;
  }
  function kindAllowed(kind) {
    var a = allowedKinds();
    if (!a) return true;
    return a.indexOf(kind === "sticker" ? "image" : kind) >= 0;
  }
  function anyAttachmentAllowed() { var a = allowedKinds(); return !a || a.length > 0; }
  /** `accept` for the file picker, so the OS dialog only offers usable types.
   *  Exact MIMEs, not wildcards: `image/*` let the iOS picker offer HEIC photos
   *  that OK_MIME then rejected — with an explicit list iOS transcodes to JPEG
   *  instead. Keep in step with OK_MIME above. */
  function acceptAttr() {
    var a = allowedKinds() || ["image", "video", "audio", "document"];
    var map = {
      image: "image/jpeg,image/png,image/gif,image/webp",
      video: "video/mp4,video/webm,video/quicktime,video/3gpp",
      audio: "audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/webm,audio/aac,audio/x-m4a",
      document: ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv",
    };
    return a.map(function (k) { return map[k] || ""; }).filter(Boolean).join(",");
  }
  /** Show/hide the attach + mic buttons to match the policy. */
  function applyAttachmentPolicy() {
    attachBtn.style.display = anyAttachmentAllowed() ? "" : "none";
    micBtn.style.display = kindAllowed("audio") ? "" : "none";
    var acc = acceptAttr();
    if (acc) fileInput.setAttribute("accept", acc); else fileInput.removeAttribute("accept");
  }

  /** MIME without parameters — `audio/webm;codecs=opus` → `audio/webm`. */
  function baseMime(t) { return String(t || "").split(";")[0].trim().toLowerCase(); }
  function uploadFile(file, opts) {
    if (!S.formDone) return;
    if (file.size > MAX_BYTES) return toast("File is too large (max 25 MB).");
    // Compare the BASE type: OK_MIME is anchored, and MediaRecorder hands back a
    // parameterised type (Chrome reports `audio/webm;codecs=opus` even when asked
    // for `audio/webm`), so testing file.type directly rejected every voice note
    // with "that file type isn't supported".
    if (file.type && !OK_MIME.test(baseMime(file.type))) return toast("That file type isn't supported.");
    dropPills(); var cid = newCid(); var kind = (file.type || "").split("/")[0]; kind = kind === "image" || kind === "video" || kind === "audio" ? kind : "document";
    var voice = !!(opts && opts.voice);
    var durationMs = (opts && opts.durationMs) || 0;
    // Caption typed alongside a staged attachment. The server inlines it on this
    // channel (supportsInlineCaption("webchatwidget") === true), so it rides on the
    // same message rather than becoming a second bubble.
    var caption = (opts && opts.caption) || "";
    var payload = { clientMsgId: cid, body: caption.slice(0, 4096), clientTs: Date.now() };
    if (opts && opts.staged && opts.staged.preview) URL.revokeObjectURL(opts.staged.preview);
    var rq = null;
    if (S.replyTo) { payload.replyToExternalId = S.replyTo.externalId; rq = { body: S.replyTo.body || "" }; }
    if (S.preChat) { payload.preChat = S.preChat; S.preChat = null; } if (S.startedNew) { payload.startedNew = true; S.startedNew = false; } clearReply();
    var m = { direction: "in", body: caption || (voice ? "🎤 Voice message" : "📎 " + (KIND_LABEL[kind] || "File")), media: null, status: "queued", createdAt: new Date().toISOString(), replyTo: rq, _local: true };
    var row = appendBubble(m, { anim: true }); S.pending[cid] = { el: row, payload: payload, status: "queued", file: file, fileName: file.name, kind: kind, voice: voice, durationMs: durationMs, ts: payload.clientTs }; renderPending(cid);
    // Persist the bytes BEFORE attempting the upload, so a refresh mid-upload (or
    // while offline) can still recover the file. Cleared on success in doUpload.
    idbPut(cid, { blob: file, name: file.name, type: file.type, kind: kind, voice: voice, durationMs: durationMs, payload: payload, createdAt: m.createdAt });
    doUpload(cid);
  }
  function doUpload(cid, after) {
    var p = S.pending[cid]; if (!p || !p.file) return after && after();
    if (!S.socket || !S.socket.connected) { markPending(cid, "queued"); return after && after(); }
    // A restored attachment is a bare Blob (IndexedDB doesn't round-trip File), so
    // pass the remembered filename explicitly — otherwise multer receives "blob"
    // and the agent sees a nameless download.
    markPending(cid, "inflight"); var fd = new FormData(); fd.append("file", p.file, p.fileName || p.file.name || "upload"); var xhr = new XMLHttpRequest();
    xhr.open("POST", apiBase + "/api/widget/media?key=" + encodeURIComponent(siteKey));
    xhr.upload.onprogress = function (e) { if (e.lengthComputable && p._prog) p._prog.querySelector("i").style.width = Math.round((e.loaded / e.total) * 100) + "%"; };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) { var media; try { media = JSON.parse(xhr.responseText); } catch (_e) { markPending(cid, "failed"); return after && after(); }
        p.payload.media = { mediaKey: media.mediaKey, mediaUrl: media.mediaUrl, kind: media.kind, mimeType: media.mimeType, sizeBytes: media.sizeBytes, filename: media.filename };
        if (p.voice) p.payload.media.voice = true;
        if (p.durationMs) p.payload.media.durationMs = p.durationMs;
        // Bytes are on the server now — drop the local copy so IndexedDB doesn't
        // grow without bound. From here the outbox row is plain JSON.
        p.file = null; idbDel(cid); if (p._prog && p._prog.parentNode) p._prog.parentNode.removeChild(p._prog); sendPayload(cid, after); }
      else { markPending(cid, "failed"); toast("Upload failed."); if (after) after(); }
    };
    xhr.onerror = function () { markPending(cid, "failed"); toast("Upload failed — check your connection."); if (after) after(); };
    // Without a timeout a stalled upload (captive portal, dead tunnel) never fires
    // onerror: the bubble sits at "inflight" with a frozen progress bar forever and
    // renderPending only offers Retry on "failed", so the visitor has no way out.
    xhr.timeout = 60000;
    xhr.ontimeout = function () { markPending(cid, "failed"); toast("Upload timed out — tap Retry."); if (after) after(); };
    xhr.send(fd);
  }
  ["dragenter", "dragover"].forEach(function (ev) { panel.addEventListener(ev, function (e) { e.preventDefault(); if (S.formDone) dropEl.classList.add("on"); }); });
  ["dragleave", "drop"].forEach(function (ev) { panel.addEventListener(ev, function (e) { e.preventDefault(); if (ev === "dragleave" && panel.contains(e.relatedTarget)) return; dropEl.classList.remove("on"); }); });
  // Drop and paste STAGE like the picker does — a mis-drop or a stray Ctrl+V used to
  // fire an irreversible send straight into the agent's inbox.
  panel.addEventListener("drop", function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) stageFile(f); });
  ta.addEventListener("paste", function (e) { var items = e.clipboardData && e.clipboardData.items; if (!items) return; for (var i = 0; i < items.length; i++) if (items[i].type.indexOf("image") === 0) { var f = items[i].getAsFile(); if (f) { e.preventDefault(); stageFile(f); } } });

  // ── typing / receipts ──────────────────────────────────────────────────────────
  var typingRow = null;
  function showTyping() {
    if (typingRow || S.closed) return; var av = el("div", { class: "av" }); var a = agentAvatar(); if (a) av.appendChild(el("img", { src: a, alt: "" })); else av.appendChild(document.createTextNode(initials(orgName())));
    typingRow = el("div", { class: "mr in" }, [av, el("div", { class: "col" }, el("div", { class: "bubble", html: '<span class="typ"><i></i><i></i><i></i></span>' }))]);
    bodyEl.appendChild(typingRow); scrollIfStuck(); emitApi("typing", true);
  }
  function hideTyping() { if (typingRow) { if (typingRow.parentNode) typingRow.parentNode.removeChild(typingRow); typingRow = null; } emitApi("typing", false); }
  function markRead() { if (!S.socket || !S.socket.connected || !S.open || document.hidden) return; if (S.readTimer) return; S.readTimer = setTimeout(function () { S.readTimer = null; if (S.socket && S.socket.connected) S.socket.emit("visitor:read"); }, 400); }

  // Visitor → agent typing (throttled; the agent inbox shows "customer is typing").
  var typingStopTimer = null;
  function emitTyping(on) { if (!S.socket || !S.socket.connected || on === S.typingOn) return; S.typingOn = on; S.socket.emit("visitor:typing", { on: on }); }
  ta.addEventListener("input", function () { emitTyping(true); if (typingStopTimer) clearTimeout(typingStopTimer); typingStopTimer = setTimeout(function () { emitTyping(false); }, 2500); });

  // ── notification sound (opt-in via config.soundEnabled) ──────────────────────
  var audioCtx = null, lastPingAt = 0;
  function playPing() {
    var cfg = (S.cfg && S.cfg.config) || {};
    if (!cfg.soundEnabled) return;
    if (lsGet(K.muted) === "1") return; // visitor-side mute (⋯ menu)
    // Coalesce bursts: a multi-bubble agent answer should chime once, not N times.
    var now = Date.now();
    if (now - lastPingAt < 1500) return;
    lastPingAt = now;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      // resume() returns a promise that REJECTS under the autoplay policy when no
      // user gesture has happened yet (inline embeds and launcher-hidden deploys
      // hit this on the first agent reply). Unhandled, it logged an error in the
      // customer's console on every message.
      if (audioCtx.state === "suspended") { var r = audioCtx.resume(); if (r && r.catch) r.catch(function () {}); }
      var t = audioCtx.currentTime;
      [880, 1175].forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain(), at = t + i * 0.11;
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.13, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
        o.connect(g); g.connect(audioCtx.destination); o.start(at); o.stop(at + 0.19);
      });
    } catch (_e) {}
  }

  // ── voice recording (MediaRecorder → upload as audio) ────────────────────────
  var recBar = null, recTimer = null, recStart = 0, recStarting = false;
  var MAX_RECORDING_SEC = 300; // hard cap so a forgotten recording can't run forever
  function toggleRecord() {
    if (S.recording) return stopRecord(true);
    // Synchronous re-entrancy latch: S.recording is only set inside the async
    // getUserMedia .then, so a second mic tap during the permission-prompt /
    // device-open window would otherwise pass the guard above and open a SECOND
    // stream+MediaRecorder — orphaning the first and leaving the visitor's mic
    // hot for the rest of the page visit. recStarting closes that window.
    if (recStarting) return;
    if (!S.formDone) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast("Voice recording isn't supported here.");
    recStarting = true;
    // Record RAW — every browser DSP stage OFF.
    //
    // A voice note has no "far end", so echo cancellation misfires when the page is
    // playing audio/video: it treats the speaker output as the reference to remove
    // and takes the speaker's VOICE with it → the warbly, unintelligible recording
    // reported. Noise suppression and auto-gain are no better with loud background
    // media: the suppressor gates the voice as "noise" and AGC pumps the level.
    // Capturing exactly what the mic hears keeps speech intelligible in every case;
    // at worst there's faint background bleed, which is vastly better than a
    // destroyed voice. (A `true` fallback covers browsers that reject the object
    // form of the constraint.)
    var micConstraint = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    navigator.mediaDevices.getUserMedia({ audio: micConstraint }).catch(function () {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }).then(function (stream) {
      recStarting = false;
      // Lost the race (another tap already started a recording, or the user
      // cancelled while the prompt was open): stop this now-orphan stream.
      if (S.recording) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : (MediaRecorder.isTypeSupported("audio/ogg") ? "audio/ogg" : "");
      // Pin the bitrate so speech quality doesn't depend on a browser default —
      // 64 kbps Opus is comfortably transparent for voice and keeps files small.
      var mrOpts = { audioBitsPerSecond: 64000 };
      if (mime) mrOpts.mimeType = mime;
      var mr = new MediaRecorder(stream, mrOpts);
      var chunks = [];
      // THE BAR MUST NOT LIE. getUserMedia resolves when the track is CREATED,
      // which on a cold device (worst of all a Bluetooth headset switching
      // profiles) is well before the first sample arrives — so a bar shown the
      // instant start() returns invites the visitor to talk into a mic that
      // isn't live yet, and the opening words are simply not in the file. The
      // encoder's first real chunk is the honest signal that audio is flowing,
      // so the bar waits for it. Nothing is lost during that wait: the recorder
      // is already running, so this delays the UI, never the audio. The
      // timeslice on start() below is what makes that chunk arrive at all —
      // with no argument, ondataavailable fires only at stop.
      var revealed = false;
      function revealRecBar() {
        if (revealed || !S.recording) return;
        revealed = true;
        micBtn.classList.add("rec");
        showRecBar();
      }
      mr.ondataavailable = function (e) { if (e.data && e.data.size) { chunks.push(e.data); revealRecBar(); } };
      mr.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        var send = S.recording && S.recording.send;
        teardownRec();
        if (send && blob.size > 0) {
          // Safari supports neither webm nor ogg, so MediaRecorder falls back to
          // audio/mp4 — naming that file "voice.webm" made the stored filename lie
          // about its container (the server sniffs bytes, so it ingested fine, but
          // the agent downloaded a mislabelled file). Derive the extension from the
          // container the recorder actually produced.
          var bt = baseMime(blob.type);
          var ext = bt.indexOf("ogg") >= 0 ? "ogg" : bt.indexOf("mp4") >= 0 ? "m4a" : "webm";
          // Duration is measured HERE, from the wall clock, because the blob's own
          // metadata is unreliable for a MediaRecorder stream (webm/opus often
          // reports Infinity until fully decoded). Without it the visitor sees a
          // voice note with no length until they press play.
          uploadFile(new File([blob], "voice." + ext, { type: blob.type }), { voice: true, durationMs: Math.max(1000, Date.now() - recStart) });
        }
      };
      S.recording = { mr: mr, send: false };
      // 100ms slice: the wait above is bounded by it, so it is the bar's
      // start-up latency (~112ms measured in Chromium — reads as instant).
      mr.start(100); recStart = Date.now();
      // A browser that never emits a chunk must not leave the visitor with no
      // bar and no way to stop; show it anyway after a beat.
      setTimeout(revealRecBar, 1500);
    }).catch(function () { recStarting = false; toast("Microphone access denied."); });
  }
  function stopRecord(send) { if (!S.recording) return; S.recording.send = send; try { S.recording.mr.stop(); } catch (_e) { teardownRec(); } }
  function teardownRec() { S.recording = null; micBtn.classList.remove("rec"); if (recTimer) { clearInterval(recTimer); recTimer = null; } if (recBar && recBar.parentNode) recBar.parentNode.removeChild(recBar); recBar = null; ibar.style.display = ""; }
  function showRecBar() {
    ibar.style.display = "none";
    var t = el("span", { class: "rt" }, "0:00");
    recBar = el("div", { class: "recbar" }, [
      el("span", { class: "rd", "aria-hidden": "true" }), t,
      el("button", { title: "Cancel", "aria-label": "Cancel recording", onclick: function () { stopRecord(false); } }, "✕"),
      el("button", { class: "snd", title: "Send", "aria-label": "Send voice message", onclick: function () { stopRecord(true); } }, "Send"),
    ]);
    composer.insertBefore(recBar, fileInput);
    if (recTimer) { clearInterval(recTimer); recTimer = null; } // never leak a prior interval
    recTimer = setInterval(function () {
      var s = Math.floor((Date.now() - recStart) / 1000);
      t.textContent = Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
      if (s >= MAX_RECORDING_SEC) { stopRecord(true); } // auto-send at the hard cap
    }, 250);
  }
  micBtn.addEventListener("click", toggleRecord);

  // ── connection ──────────────────────────────────────────────────────────────────
  function paintPresence() {
    // Green only when an agent is actually reachable; amber while WE are
    // reconnecting; grey when no agent is online. `S.agentsOnline` is undefined
    // until the first `agents` frame — treat that as unknown → grey, not a false
    // green.
    var cls = "hdot";
    if (S.conn === "reconnecting") cls += " re";
    else if (S.agentsOnline) cls += "";
    else cls += " off";
    hdot.className = cls;
    // Unknown (pre-`agents` frame) is neutral — claiming "we're away" before the
    // first presence frame contradicted the banner's own unknown≠away handling.
    hdot.title = S.agentsOnline ? "An agent is online" : S.agentsOnline === false ? "We're away — leave a message and we'll reply" : "Chat with us";
    // Away banner: only once we actually KNOW no agent is online (not while unknown).
    var cfg = (S.cfg && S.cfg.config) || {};
    var away = S.agentsOnline === false;
    // Default copy promises nothing specific — "by email" was a lie for orgs that
    // never collect an email. Orgs that do reply by email say so in awayMessage.
    awayBar.textContent = cfg.awayMessage || "We're away right now — leave a message and we'll get back to you.";
    awayBar.classList.toggle("on", away);
    paintHeaderStatus();
  }
  /**
   * The one line under the title, and the only place that writes it.
   *
   * Priority is deliberate:
   *   1. a connection problem — nothing else matters if we can't deliver;
   *   2. "Active now" when an agent is genuinely there. This is what the visitor
   *      most wants to know and had no way to see: a second tick means DELIVERED,
   *      not "a person is reading this", so a quiet thread was indistinguishable
   *      from an unattended one. The avatar dot carried this in COLOUR alone,
   *      which says nothing to someone who doesn't know the convention;
   *   3. the org's own subtitle — which is also where "Away" defers to, because
   *      the away BANNER already spells that state out in the body and repeating
   *      it here would cost the org their line for no new information.
   *
   * "idle" (socket not opened yet, by design) and "connecting" are NOT failures:
   * showing "Offline" for them flashed a scary status the instant a visitor
   * opened the chat.
   */
  function paintHeaderStatus() {
    var cfg = (S.cfg && S.cfg.config) || {};
    var live = S.conn !== "reconnecting" && S.conn !== "offline";
    var t =
      S.conn === "reconnecting" ? "Reconnecting…"
      : S.conn === "offline" ? "Offline"
      : S.agentsOnline === true ? "Active now"
      : cfg.headerSubtitle || (S.agentsOnline === false ? "Away" : "");
    subEl.textContent = t;
    subEl.style.display = t ? "" : "none";
    subEl.classList.toggle("live", live && S.agentsOnline === true);
  }
  function setConn(c) {
    S.conn = c; paintPresence();
    reStrip.classList.toggle("on", c === "reconnecting");
  }
  function connect() {
    // transports: websocket FIRST, polling as the fallback. Websocket-only was a
    // hard failure on any corporate proxy / captive portal that blocks the upgrade —
    // the visitor sat on "Reconnecting…" forever while reconnectionAttempts:Infinity
    // retried a transport that was never going to work. Intercom/Crisp/Tawk all fall
    // back for this reason.
    //
    // `tryAllTransports` is REQUIRED, not decorative: socket.io defaults it to FALSE,
    // meaning if the FIRST transport fails it gives up rather than trying the next —
    // so listing "polling" second did nothing on its own, and an e2e run with
    // WebSockets blocked failed until this was added. Websocket stays first so the
    // 99% who can use it never pay for a polling handshake.
    //
    // `query.widget=1` is REQUIRED for the polling half to work at all: polling is
    // plain XHR and therefore CORS-checked (websockets are not), and the server
    // pins socket CORS to the app origin with credentials. The flag tells the CORS
    // delegate in ws-adapter.ts to reflect this customer's origin WITHOUT
    // credentials instead. Keep in step with WIDGET_HANDSHAKE_FLAG in
    // @ccp/shared/socket/events (this file is un-bundled, so it can't import it).
    var socket = S.io(apiBase + "/widget", { path: "/api/socket", transports: ["websocket", "polling"], tryAllTransports: true, query: { widget: "1" }, auth: { siteKey: siteKey, visitorId: S.visitorId }, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 800, reconnectionDelayMax: 8000, timeout: 12000 });
    S.socket = socket;
    // Presence must flip to "left" the instant the visitor closes the tab, not after
    // the server's ~45s ping-timeout. `pagehide` fires on close/navigate (and mobile
    // bfcache); disconnecting sends an immediate close so agents see them leave. On a
    // bfcache restore (`pageshow persisted`) we reconnect — the manual disconnect
    // above disabled auto-reconnect. Bound once, reads the live S.socket.
    if (!S.lifecycleBound) {
      S.lifecycleBound = true;
      window.addEventListener("pagehide", function () { try { if (S.socket && S.socket.connected) S.socket.disconnect(); } catch (e) {} });
      window.addEventListener("pageshow", function (e) { if (e.persisted && S.socket && !S.socket.connected && !S.fatal) { try { S.socket.connect(); } catch (er) {} } });
    }
    socket.on("connect", function () {
      setConn("online"); bodyEl.querySelectorAll(".sys.io-err").forEach(function (n) { n.remove(); });
      S.retryDelay = 0; // healthy again — next outage starts from the short delay
      // The server assumes a fresh socket means "present". Correct it immediately
      // when this connect happened in a hidden tab (background reconnect).
      S.presenceSent = true; emitPresence();
      flushOutbox(); markRead();
    });
    socket.on("disconnect", function (reason) {
      // Reset the typing latch: the server cleared its per-socket state on the
      // drop, so a stale `true` here swallowed the first typing signal after
      // reconnect. Same for presence — the server assumes present on connect.
      S.typingOn = false; S.presenceSent = true;
      flushGen++;
      // Release the flush latch. A chain parked inside sendPayload waiting on an
      // ack never reaches next(), so `flushing` stayed true and the RECONNECT's
      // flushOutbox() returned at its first check — queued messages then sat
      // undelivered until each 12s send-timeout expired one at a time, with a
      // false ⚠ Retry on the first. Re-arming interrupted sends on reconnect is
      // exactly what flushOutbox's header promises; this is what makes it true.
      // Re-sending is safe: same clientMsgId, and the server dedupes on externalId.
      flushing = false;
      setConn("reconnecting"); hideTyping();
      if (reason === "io server disconnect" && !S.fatal) { socket.connect(); }
    });
    socket.io.on("reconnect_attempt", function () { setConn("reconnecting"); });
    // A rejected handshake is TERMINAL, not transient: retrying forever (attempts
    // Infinity) just hides a misconfiguration behind a "Reconnecting…" strip while
    // the visitor sees a chat that never works. Stop, say so, and put the reason in
    // the console so whoever installed the snippet can actually fix it.
    socket.on("connect_error", function (err) {
      var reason = String((err && (err.message || err.data)) || "");
      if (/unknown_site_key|origin_not_allowed|bad_handshake/.test(reason)) {
        S.fatal = true;
        socket.disconnect();
        setConn("offline");
        console.error(
          "[webchat] chat unavailable (" + reason + "). " +
          (reason === "origin_not_allowed"
            ? "Add " + location.origin + " to this widget's allowed origins in Settings → Website chat."
            : "Check the data-webchat-key value against Settings → Website chat.")
        );
        // Terminal — hide the loading pill and the composer, or the visitor types
        // into a box whose sends queue forever with no path to delivery.
        hideLoading();
        composer.style.display = "none";
        appendSys("Chat is unavailable right now. Please try again later.");
        return;
      }
      setConn("reconnecting");
      // A MIDDLEWARE rejection is not a transport failure: socket.io marks the
      // client INACTIVE and stops retrying on its own. So a TRANSIENT server-side
      // handshake failure (a DB blip while resolving the site key) left the widget
      // on "Reconnecting…" forever with nothing behind it — recoverable only by a
      // page reload the visitor has no reason to try. Retry ourselves, with
      // capped backoff, until it comes back.
      if (socket.active === false && !S.fatal) {
        S.retryDelay = Math.min((S.retryDelay || 800) * 2, 30000);
        setTimeout(function () {
          if (S.fatal || S.socket !== socket || socket.connected) return;
          try { socket.connect(); } catch (_e) {}
        }, S.retryDelay);
      }
    });
    socket.on("ready", onReady);
    socket.on("history", function (p) {
      // Before any row renders: messages are appended ahead of initView(), so a
      // skeleton torn down later would sit above the real thread for a frame.
      hideLoading();
      var msgs = (p && p.messages) || [];
      // "load earlier" availability travels with every history batch.
      if (!S.oldestCursor && msgs.length) S.oldestCursor = { ts: msgs[0].createdAt, id: msgs[0].id };
      S.hasMore = !!(p && p.hasMore); showEarlier(S.hasMore);
      if (!msgs.length) { initView(false); resortPending(); return; }
      // Boot renders queued outbox bubbles BEFORE history arrives, so on the first
      // history render they sit above the whole thread with a stray "Today" pill.
      // Wipe the day labels (the render below rebuilds them) and move the pending
      // rows back to the bottom, where unsent messages belong.
      var hadPending = false;
      for (var pc in S.pending) { hadPending = true; break; }
      if (!S.viewInit && hadPending) {
        bodyEl.querySelectorAll(".day").forEach(function (n) { n.remove(); });
        S.lastDayLabel = null;
      }
      S.lastGroup = null; var unseen = 0;
      msgs.forEach(function (m) { var isNew = !(m.id && S.byId[m.id]); upsert(m, true); if (isNew && m.direction === "out" && new Date(m.createdAt).getTime() > S.lastSeenTs) unseen++; });
      initView(true);
      S.formDone = true; composer.style.display = ""; dropPills(); lsSet(K.chatted, "1"); lsSet(K.active, String(Date.now()));
      resortPending();
      if (unseen && !S.open) { S.unread = 0; for (var i = 0; i < unseen; i++) bumpUnread(); }
      scrollToBottom(false); markRead();
    });
    socket.on("message", function (m) { upsert(m, false); });
    socket.on("message:status", function (p) { if (p && p.id) applyStatus(p.id, p.status); });
    // Safety auto-clear mirrors the agent side (use-typing.ts): if the "off" frame
    // is lost — e.g. the visitor's socket drops while the agent is mid-sentence, so
    // the off is emitted to a room this client already left — the dots would
    // otherwise persist forever (history replay never clears them).
    socket.on("agents", function (p) { S.agentsOnline = !!(p && p.online); paintPresence(); });
    socket.on("typing", function (p) {
      if (S.typingClear) { clearTimeout(S.typingClear); S.typingClear = null; }
      if (p && p.on) {
        showTyping(); scrollToBottom(false);
        S.typingClear = setTimeout(function () { S.typingClear = null; hideTyping(); }, 8000);
      } else hideTyping();
    });
    socket.on("conversation:status", function (p) { if (p && p.status === "closed") { S.closed = true; appendClosed(); } else if (p && p.status) { S.closed = false; bodyEl.querySelectorAll(".sys.closed").forEach(function (n) { n.remove(); }); } });
  }
  function appendClosed() {
    if (bodyEl.querySelector(".sys.closed")) return;
    var wrap = el("div", { class: "sys closed", dir: "auto" }, [
      el("div", null, "This chat was closed. Send a message to continue it, or:"),
      el("button", { class: "cstart", type: "button", onclick: requestReset }, "Start a new conversation"),
    ]);
    bodyEl.appendChild(wrap); scrollIfStuck();
  }

  // ── boot ──────────────────────────────────────────────────────────────────────
  /**
   * Open the socket if it isn't already. Idempotent — safe to call from every
   * entry point that needs live delivery.
   */
  function ensureConnected() {
    if (S.socket || S.fatal) return;
    setConn("connecting");
    if (S.io) { connect(); return; }
    if (S.loadingIo) return;
    S.loadingIo = true;
    var s = document.createElement("script");
    s.src = staticBase + "/webchat/socket.io.min.js";
    s.async = true;
    // The vendored client is a UMD build, so loading it DEFINES window.io on the
    // host page. Two ways that bit us:
    //   - we used to reuse an existing `window.io`, so on a site already running
    //     socket.io we adopted THEIR version — a v2/v4 protocol mismatch broke the
    //     widget with no diagnostic;
    //   - and we clobbered theirs when we loaded first.
    // So: snapshot whatever the host had, capture ours privately as `S.io`, then
    // put the host's value back exactly as it was (including absent).
    var hostIo = window.io, hadHostIo = "io" in window;
    var restore = function () {
      if (hadHostIo) window.io = hostIo;
      else { try { delete window.io; } catch (_e) { window.io = undefined; } }
    };
    s.onload = function () {
      S.loadingIo = false;
      S.io = window.io;
      restore();
      connect();
    };
    s.onerror = function () {
      S.loadingIo = false; restore(); setConn("offline");
      // Say so in the panel — an open chat stuck on the loading pill forever reads
      // as broken. Cleared on a later successful connect (retry path).
      hideLoading();
      if (!bodyEl.querySelector(".sys.io-err")) bodyEl.appendChild(el("div", { class: "sys io-err" }, "Chat couldn't load. Check your connection and try again."));
      console.error("[webchat] failed to load socket.io client");
    };
    document.head.appendChild(s);
  }

  /**
   * Boot WITHOUT a socket where possible.
   *
   * A socket per page load meant concurrent connections tracked total visitors
   * browsing every customer site, not people chatting — by far the largest load
   * this channel puts on the server. Appearance now comes from a cheap cacheable
   * GET, so an idle page view costs one HTTP request and no persistent connection.
   *
   * We still connect EAGERLY when the visitor needs live delivery:
   *   - they've chatted before (agent replies + unread badge must arrive unprompted)
   *   - queued messages are waiting to flush
   *   - inline embeds, which are always-open by definition
   * Otherwise the socket opens the moment they open the chat.
   */
  function boot() {
    // Theme synchronously from the cached appearance — boot() runs before the
    // browser's first paint, so a returning visitor never sees the default colors
    // even for a frame. The real config (HTTP or socket `ready`) re-applies over
    // it moments later, which is a no-op unless the org changed their settings.
    if (cachedCfg) applyConfig(cachedCfg, true);
    // Draft first, and independent of the socket: restoreDraft() used to run only
    // from onReady(), so a visitor whose handshake failed — or who simply had not
    // opened the panel yet — saw an empty box even though their text was saved.
    restoreDraft();
    restoreOutbox();
    // Async (IndexedDB): re-hydrates any attachment queued when the tab closed and
    // connects itself if it finds one. See restoreAttachments.
    restoreAttachments();
    var hasQueued = false;
    for (var _cid in S.pending) { hasQueued = true; break; }
    // Reopen if they left it open. Deliberately AFTER the restores so the panel
    // paints with the draft and any queued bubbles already in place, and only in
    // launcher mode (inline is always open by definition).
    syncPanelSize();
    var wasOpen = !INLINE && lsGet(K.open) === "1";
    var needsLive = INLINE || S.open || wasOpen || !!lsGet(K.chatted) || hasQueued;
    // Inline embeds are open by definition — give them the loading pill too.
    if (INLINE) showLoading();
    if (wasOpen) openPanel();
    if (needsLive) { ensureConnected(); return; }
    setConn("idle");
    // Paint the launcher with the org's real branding without a socket. On failure
    // we simply connect — correctness never depends on this request succeeding.
    fetch(apiBase + "/api/widget/config?key=" + encodeURIComponent(siteKey), { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { if (p && p.config && !S.socket) applyConfig(p); })
      .catch(function () { ensureConnected(); });
  }
  boot();
})();
