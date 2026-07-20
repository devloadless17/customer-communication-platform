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
  var S = {
    socket: null, conn: "connecting", open: INLINE, ready: false, viewInit: false,
    formDone: false, closed: false, cfg: null, preChat: null, replyTo: null, fatal: false,
    /** File picked but not sent yet — see stageFile/clearStage. */
    staged: null,
    byId: {}, pending: {}, unread: 0, lastSeenTs: Number(lsGet(K.seen) || 0),
    lastGroup: null, stick: true, readTimer: null, typingClear: null,
    hasMore: false, oldestCursor: null, loadingOlder: false, typingOn: false, recording: null,
    visitorId: lsGet(K.visitor) || newVisitorId(),
  };
  lsSet(K.visitor, S.visitorId);
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
    ".root{--c:" + BRAND + ";--ct:#fff;--lc:" + BRAND + ";--uc:" + BRAND + ";--uct:#fff;--surface:#fff;--surface2:#f5f7fb;--inb:#fff;--border:#e6e9f0;--ink:#0f1729;--ink2:#66748c;--radius:20px;font-family:var(--font,ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif);color:var(--ink)}",
    ".root.dark{--surface:#0f172a;--surface2:#0b1220;--inb:#1e293b;--border:#243244;--ink:#e8edf6;--ink2:#93a1b8}",
    // Inline embeds fill their host container. `min-height` is the safety net: an
    // ancestor chain with no resolved height makes `height:100%` collapse to zero,
    // which reads as "the widget didn't load" rather than "size your container".
    // Wider media too — a full-page inline chat showing 236px images looked broken.
    ".root.inl{height:100%;min-height:320px;--media-max:min(100%,420px)}",
    ".launch{position:fixed;bottom:22px;z-index:2147483646;display:flex;align-items:center;gap:10px;border:0;background:transparent;cursor:pointer;padding:0}",
    ".launch.right{right:22px;flex-direction:row}.launch.left{left:22px;flex-direction:row-reverse}",
    // NOTE on the doubled `background` declarations here and below: color-mix() is
    // Chrome 111+/Safari 16.2+, and an engine that doesn't grok it drops the WHOLE
    // declaration. Without a flat fallback first, iOS 15 and the Facebook/Instagram
    // in-app browsers render an invisible launcher, a white-on-white header, and
    // unreadable outgoing bubbles. The flat colour lands first; modern engines then
    // override it with the gradient.
    ".launch .b{width:60px;height:60px;border-radius:9999px;background:var(--lc);background:linear-gradient(145deg,var(--lc),color-mix(in srgb,var(--lc) 78%,#000));color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 30px -8px color-mix(in srgb,var(--lc) 60%,transparent),0 4px 10px rgba(0,0,0,.12);transition:transform .18s ease}",
    ".launch:hover .b{transform:scale(1.06)}.launch:active .b{transform:scale(.95)}.launch .b svg{width:28px;height:28px}.launch .b img{width:30px;height:30px;border-radius:9999px;object-fit:cover}",
    ".launch .lbl{background:var(--surface);color:var(--ink);font-size:13.5px;font-weight:600;padding:9px 14px;border-radius:9999px;box-shadow:0 8px 22px -8px rgba(0,0,0,.25);white-space:nowrap;display:none}",
    ".launch.showlbl .lbl{display:block}",
    ".badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:9999px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--surface)}.badge.on{display:flex}",
    ".lwrap{position:relative;display:flex}",
    ".panel{position:fixed;bottom:94px;z-index:2147483647;width:392px;max-width:calc(100vw - 24px);height:min(640px,calc(100vh - 116px));background:var(--surface);border-radius:var(--radius);box-shadow:0 32px 64px -16px rgba(15,23,42,.34),0 0 0 1px var(--border);display:none;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px) scale(.98)}",
    ".panel.right{right:22px}.panel.left{left:22px}",
    ".panel.open{display:flex}.panel.in{opacity:1;transform:none;transition:opacity .22s ease,transform .22s cubic-bezier(.2,.8,.2,1)}",
    ".panel.inline{position:relative;right:auto;left:auto;bottom:auto;width:100%;height:100%;max-width:100%;border-radius:var(--radius);opacity:1;transform:none;display:flex;box-shadow:0 0 0 1px var(--border)}",
    "@media (max-width:480px){.panel:not(.inline){right:0;left:0;bottom:0;top:0;width:100vw;max-width:100vw;height:100vh;height:100dvh;border-radius:0}}",
    // iOS Safari auto-zooms the HOST PAGE when a form control with font-size < 16px
    // takes focus, and never zooms back out — so tapping the message box left the
    // client's site zoomed in and horizontally scrollable. 16px on mobile is the
    // documented way to opt out; desktop keeps the tighter 14px above.
    "@media (max-width:480px){.composer textarea,.form input{font-size:16px}}",
    "header{display:flex;align-items:center;gap:11px;padding:15px 16px;background:var(--c);background:linear-gradient(135deg,var(--c),color-mix(in srgb,var(--c) 82%,#000));color:var(--ct);flex:0 0 auto}",
    ".hava{width:38px;height:38px;border-radius:11px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;position:relative;overflow:hidden;flex:0 0 auto}.hava img{width:100%;height:100%;object-fit:cover}",
    ".hdot{position:absolute;right:-2px;bottom:-2px;width:12px;height:12px;border-radius:9999px;background:#22c55e;box-shadow:0 0 0 2px var(--c)}.hdot.re{background:#f59e0b}.hdot.off{background:#9ca3af}",
    ".htxt{flex:1;min-width:0}.htxt b{display:block;font-size:15.5px;font-weight:700;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.25}.htxt small{font-size:12px;opacity:.9}",
    ".hx{background:transparent;border:0;color:inherit;cursor:pointer;opacity:.9;padding:7px;border-radius:9px;display:flex}.hx:hover{opacity:1;background:rgba(255,255,255,.16)}.hx svg{width:18px;height:18px}",
    ".restrip{background:#fff7ed;color:#9a3412;font-size:12px;text-align:center;padding:6px;flex:0 0 auto;display:none}.root.dark .restrip{background:#3a2a12;color:#fbbf77}.restrip.on{display:block}",
    ".body{flex:1 1 auto;overflow-y:auto;padding:16px 14px;background:var(--surface2);display:flex;flex-direction:column;gap:3px;position:relative;scroll-behavior:smooth}",
    ".body::-webkit-scrollbar{width:8px}.body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--ink2) 35%,transparent);border-radius:8px}",
    ".day{align-self:center;font-size:11px;font-weight:600;color:var(--ink2);background:color-mix(in srgb,var(--ink2) 12%,transparent);border-radius:9999px;padding:3px 11px;margin:8px 0}",
    ".sname{font-size:11.5px;font-weight:600;color:var(--ink2);margin:6px 0 1px 40px}",
    ".mr{display:flex;gap:8px;align-items:flex-end;max-width:86%;margin-top:2px}.mr.out{align-self:flex-end;flex-direction:row-reverse}.mr.in{align-self:flex-start}",
    ".mr .av{width:28px;height:28px;border-radius:9999px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;color:#fff;background:linear-gradient(145deg,#94a3b8,#64748b);overflow:hidden}.mr .av img{width:100%;height:100%;object-fit:cover}.mr.out .av,.mr.grp .av{display:none}.mr.grp{margin-left:36px}.mr.grp.out{margin-left:0;margin-right:0}",
    ".col{display:flex;flex-direction:column;min-width:0}.mr.out .col{align-items:flex-end}",
    ".bubble{padding:10px 13px;border-radius:17px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;max-width:100%;box-shadow:0 1px 1px rgba(15,23,42,.05)}",
    reduceMotion ? "" : ".bubble.anim{animation:cin .2s ease-out}@keyframes cin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
    ".mr.out .bubble{background:var(--uc);background:linear-gradient(145deg,var(--uc),color-mix(in srgb,var(--uc) 88%,#000));color:var(--uct);border-bottom-right-radius:6px}",
    ".mr.in .bubble{background:var(--inb);color:var(--ink);border:1px solid var(--border);border-bottom-left-radius:6px}",
    ".bubble a{color:inherit;text-decoration:underline;text-underline-offset:2px}",
    ".meta{font-size:10.5px;color:var(--ink2);margin:3px 5px 0;display:flex;gap:4px;align-items:center}.tick.err{color:#ef4444}.retry{color:#ef4444;cursor:pointer;text-decoration:underline}.tick.read{color:#38bdf8}",
    ".rep{opacity:0;background:transparent;border:0;color:var(--ink2);cursor:pointer;font-size:14px;align-self:center;padding:4px;border-radius:7px;transition:opacity .12s}.mr:hover .rep{opacity:.7}.rep:hover{opacity:1;background:color-mix(in srgb,var(--ink2) 14%,transparent)}",
    ".rq{border-left:3px solid rgba(0,0,0,.18);padding:2px 8px;margin-bottom:5px;font-size:12.5px;opacity:.85;max-height:44px;overflow:hidden}.mr.out .rq{border-left-color:rgba(255,255,255,.55)}.rq.jump{cursor:pointer}.rq.jump:hover{opacity:1}",
    // Brief highlight on the message a quote jumped to, so the eye lands on it.
    "@keyframes rqflash{0%,100%{background:transparent}25%,75%{background:color-mix(in srgb,var(--c) 26%,transparent)}}.mr.flash{animation:rqflash 1.2s ease}",
    ".media img,.media video{max-width:var(--media-max,236px);max-height:250px;border-radius:13px;display:block;cursor:pointer}.media audio{width:var(--media-max,236px);max-width:100%}",
    ".doc{display:flex;align-items:center;gap:9px;text-decoration:none;color:inherit;font-size:13px}.doc .ic{width:32px;height:32px;flex:0 0 auto;border-radius:8px;background:rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center}",
    ".prog{height:4px;background:rgba(0,0,0,.14);border-radius:9999px;overflow:hidden;margin-top:7px}.prog i{display:block;height:100%;background:currentColor;width:0;transition:width .15s}",
    ".typ{display:inline-flex;gap:4px;padding:4px 2px}.typ i{width:6px;height:6px;background:var(--ink2);border-radius:9999px;animation:tb 1s infinite}.typ i:nth-child(2){animation-delay:.15s}.typ i:nth-child(3){animation-delay:.3s}@keyframes tb{0%,80%,100%{transform:scale(.6);opacity:.5}40%{transform:scale(1);opacity:1}}",
    ".pills{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}.pill{background:var(--surface);color:var(--c);border:1px solid var(--border);border-radius:9999px;padding:8px 14px;font-size:13px;font-weight:500;cursor:pointer;transition:.12s}.pill:hover{background:var(--c);color:var(--ct);border-color:var(--c)}",
    ".sys{align-self:center;font-size:12px;color:var(--ink2);background:color-mix(in srgb,var(--ink2) 12%,transparent);border-radius:11px;padding:6px 13px;text-align:center;margin:6px 0}",
    ".newp{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;background:var(--c);color:var(--ct);border:0;border-radius:9999px;padding:7px 15px;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 8px 20px -6px rgba(0,0,0,.35);display:none}.newp.on{display:block}",
    ".form{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:11px;margin-top:6px}.form h3{margin:0;font-size:15px;font-weight:700}.form p{margin:0;font-size:13px;color:var(--ink2)}.form .fld{display:flex;flex-direction:column;gap:5px}.form label{font-size:12px;font-weight:600}.form input{font:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--border);border-radius:11px;outline:none;background:var(--surface);color:var(--ink)}.form input:focus{border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 18%,transparent)}",
    ".err{color:#dc2626;font-size:12px}",
    ".rc{display:none;align-items:center;gap:9px;padding:8px 14px;background:color-mix(in srgb,var(--c) 8%,var(--surface));border-top:1px solid var(--border);font-size:12.5px;color:var(--ink);flex:0 0 auto}.rc.on{display:flex}.rc .qt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rc button{border:0;background:transparent;cursor:pointer;color:var(--ink2);font-size:16px}",
    ".composer{padding:12px 14px 14px;background:var(--surface);flex:0 0 auto}",
    // Staged-attachment chip: the file the visitor picked but hasn't sent yet.
    ".stg{display:none;align-items:center;gap:10px;margin-bottom:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:14px}.stg.on{display:flex}.stg img{width:40px;height:40px;flex:0 0 auto;object-fit:cover;border-radius:9px}.stg .ic{width:40px;height:40px;flex:0 0 auto;border-radius:9px;background:color-mix(in srgb,var(--ink2) 12%,transparent);display:flex;align-items:center;justify-content:center;font-size:18px}.stg .meta{flex:1;min-width:0}.stg .nm{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stg .sz{font-size:11.5px;color:var(--ink2)}.stg .x{border:0;background:transparent;cursor:pointer;color:var(--ink2);font-size:17px;line-height:1;padding:4px}.stg .x:hover{color:var(--ink)}",
    ".ibar{display:flex;align-items:flex-end;gap:4px;background:var(--surface2);border:1.5px solid var(--border);border-radius:24px;padding:5px 5px 5px 7px;transition:border-color .15s,box-shadow .15s}.ibar.focus{border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 16%,transparent)}",
    ".composer textarea{flex:1;resize:none;border:0;outline:none;background:transparent;font:inherit;font-size:14px;line-height:1.45;padding:8px 6px;max-height:112px;min-height:20px;overflow-y:hidden;color:var(--ink);appearance:none;-webkit-appearance:none}",
    ".rbtn{width:38px;height:38px;flex:0 0 auto;border:0;border-radius:9999px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:transparent;color:var(--ink2);transition:.12s}.rbtn:hover{background:color-mix(in srgb,var(--ink2) 14%,transparent);color:var(--ink)}.rbtn svg{width:19px;height:19px}",
    ".sbtn{background:var(--c);color:var(--ct)}.sbtn:hover{filter:brightness(1.06);background:var(--c)}.sbtn:disabled{opacity:.4;cursor:not-allowed;filter:none}",
    ".foot{font-size:11px;color:var(--ink2);text-align:center;padding:2px 0 0;flex:0 0 auto}.foot a{color:inherit;text-decoration:none;font-weight:600}",
    ".earlier{display:flex;justify-content:center;padding:2px 0 8px}.earlierbtn{background:var(--surface);color:var(--ink2);border:1px solid var(--border);border-radius:9999px;padding:5px 14px;font-size:12px;cursor:pointer;transition:.12s}.earlierbtn:hover{background:var(--surface2);color:var(--ink)}.earlierbtn:disabled{opacity:.6;cursor:default}",
    ".rbtn.rec{background:#ef4444;color:#fff}",
    ".recbar{display:flex;align-items:center;gap:9px;flex:1;color:var(--ink);font-size:13px;padding:0 6px}.recbar .rd{width:9px;height:9px;border-radius:9999px;background:#ef4444;animation:rpulse 1.1s infinite}@keyframes rpulse{0%,100%{opacity:1}50%{opacity:.35}}.recbar .rt{flex:1;font-variant-numeric:tabular-nums}.recbar button{border:0;background:transparent;cursor:pointer;color:var(--ink2);font-size:16px;padding:2px 4px}.recbar .snd{color:var(--c);font-weight:700}",
    ".drop{position:absolute;inset:8px;background:color-mix(in srgb,var(--c) 10%,transparent);border:2px dashed var(--c);border-radius:14px;display:none;align-items:center;justify-content:center;color:var(--c);font-weight:700;z-index:5}.drop.on{display:flex}",
    ".toast{position:absolute;left:14px;right:14px;bottom:74px;background:#111827;color:#fff;font-size:13px;padding:10px 13px;border-radius:12px;opacity:0;transition:opacity .2s;pointer-events:none;text-align:center;z-index:6}.toast.on{opacity:.97}",
    ".lb{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:2147483647;display:none;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}.lb.on{display:flex}.lb img{max-width:100%;max-height:100%;border-radius:10px}",
  ].join("");
  var st = document.createElement("style"); st.textContent = css; shadow.appendChild(st);
  var root = el("div", { class: "root" }); shadow.appendChild(root);

  // ── launcher ───────────────────────────────────────────────────────────────
  var launcher = null, badge = el("span", { class: "badge", "aria-hidden": "true" });
  if (A.launcher && !INLINE) {
    var lb = el("span", { class: "b" });
    lb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var lwrap = el("div", { class: "lwrap" }, [lb, badge]);
    launcher = el("button", { class: "launch " + A.position + (A.label ? " showlbl" : ""), "aria-label": "Open chat", "aria-haspopup": "dialog" },
      A.position === "left" ? [lwrap, el("span", { class: "lbl" }, A.label)] : [el("span", { class: "lbl" }, A.label), lwrap]);
    root.appendChild(launcher);
  }

  // ── panel ────────────────────────────────────────────────────────────────
  var panel = el("div", { class: "panel " + (INLINE ? "inline" : A.position), role: "dialog", "aria-modal": INLINE ? "false" : "true", "aria-label": "Chat" });
  var hava = el("div", { class: "hava" }); var havaInit = document.createTextNode("•"); hava.appendChild(havaInit);
  var hdot = el("span", { class: "hdot", "aria-hidden": "true" }); hava.appendChild(hdot);
  var titleEl = el("b", null, "Chat"); var subEl = el("small", null, "");
  var closeBtn = el("button", { class: "hx", "aria-label": "Close chat", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' });
  var headerEl = el("header", null, [hava, el("div", { class: "htxt" }, [titleEl, subEl])]);
  if (!INLINE) headerEl.appendChild(closeBtn);
  panel.appendChild(headerEl);
  var reStrip = el("div", { class: "restrip" }, "Reconnecting…"); panel.appendChild(reStrip);
  var bodyEl = el("div", { class: "body", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
  var newPill = el("button", { class: "newp" }, "↓ New messages");
  var dropEl = el("div", { class: "drop" }, "Drop to send");
  var toastEl = el("div", { class: "toast", role: "status" });
  var earlierBar = el("div", { class: "earlier" });
  var earlierBtn = el("button", { class: "earlierbtn", onclick: function () { loadOlder(); } }, "Load earlier messages");
  earlierBar.appendChild(earlierBtn); earlierBar.style.display = "none";
  bodyEl.appendChild(newPill); bodyEl.appendChild(dropEl); bodyEl.appendChild(toastEl); bodyEl.appendChild(earlierBar);
  panel.appendChild(bodyEl);
  var replyBar = el("div", { class: "rc" }); var replyQt = el("div", { class: "qt" });
  replyBar.appendChild(el("span", null, "Reply:")); replyBar.appendChild(replyQt);
  replyBar.appendChild(el("button", { "aria-label": "Cancel reply", onclick: clearReply }, "✕"));
  panel.appendChild(replyBar);
  var fileInput = el("input", { type: "file", style: "display:none", "aria-hidden": "true" });
  var attachBtn = el("button", { class: "rbtn", "aria-label": "Attach a file", title: "Attach", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' });
  var ta = el("textarea", { rows: "1", placeholder: "Type a message…", "aria-label": "Message", dir: "auto" });
  var sendBtn = el("button", { class: "rbtn sbtn", "aria-label": "Send message", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' });
  var micBtn = el("button", { class: "rbtn", "aria-label": "Record a voice message", title: "Voice message", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>' });
  var ibar = el("div", { class: "ibar" }, [attachBtn, micBtn, ta, sendBtn]);
  // Staged attachment preview. Picking a file no longer sends it: it lands here so
  // the visitor can confirm they chose the right one and add a caption, matching
  // both the agent composer and every mainstream messenger.
  var stgThumb = el("span", { class: "ic" }, "📎");
  var stgName = el("div", { class: "nm" });
  var stgSize = el("div", { class: "sz" });
  var stgClear = el("button", { class: "x", type: "button", "aria-label": "Remove attachment", html: "&times;" });
  var stageEl = el("div", { class: "stg" }, [stgThumb, el("div", { class: "meta" }, [stgName, stgSize]), stgClear]);
  var composer = el("div", { class: "composer" }, [stageEl, ibar, fileInput]);
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
    if (window.innerWidth > 480) { panel.style.height = ""; return; }
    panel.style.height = vv.height + "px";
    scrollToBottom(false);
  }
  if (vv) { vv.addEventListener("resize", syncViewport); vv.addEventListener("scroll", syncViewport); }
  function openPanel() {
    if (INLINE) return;
    // Opening the chat is the moment a socket is actually needed (see boot()).
    ensureConnected();
    S.open = true; panel.classList.add("open"); requestAnimationFrame(function () { panel.classList.add("in"); });
    if (launcher) launcher.style.display = "none";
    clearUnread(); if (S.formDone) setTimeout(function () { ta.focus(); }, 40); scrollToBottom(true); markRead();
    lsSet(K.open, "1");
    syncViewport();
  }
  function closePanel() {
    if (INLINE) return;
    S.open = false; panel.classList.remove("in"); panel.classList.remove("open");
    panel.style.height = "";
    if (launcher) launcher.style.display = "flex";
    lsDel(K.open);
    if (lastFocus && lastFocus.focus) lastFocus.focus(); else if (launcher) launcher.focus();
  }
  if (launcher) launcher.addEventListener("click", function () { lastFocus = launcher; openPanel(); });
  closeBtn.addEventListener("click", closePanel);
  panel.addEventListener("keydown", function (e) {
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
  function applyConfig(payload) {
    S.cfg = payload || {}; var cfg = (payload && payload.config) || {}, th = cfg.theme || {};
    var c = hex(th.primaryColor) || BRAND, lc = hex(th.launcherColor) || c, uc = hex(th.userBubbleColor) || c;
    root.style.setProperty("--c", c); root.style.setProperty("--ct", contrastOn(c));
    root.style.setProperty("--lc", lc); root.style.setProperty("--uc", uc); root.style.setProperty("--uct", contrastOn(uc));
    var font = cfg.fontFamily === "rounded" ? "'Nunito',ui-rounded,'Segoe UI',system-ui,sans-serif" : cfg.fontFamily === "serif" ? "Georgia,'Times New Roman',serif" : "";
    if (font) root.style.setProperty("--font", font); else root.style.removeProperty("--font");
    var dark = cfg.themeMode === "dark" || (cfg.themeMode === "auto" && (function () { try { return matchMedia("(prefers-color-scheme:dark)").matches; } catch (_e) { return false; } })());
    root.classList.toggle("dark", !!dark);
    var name = cfg.headerTitle || (payload && payload.name) || "Chat";
    titleEl.textContent = name;
    if (cfg.logoDataUrl) { hava.innerHTML = ""; hava.appendChild(el("img", { src: cfg.logoDataUrl, alt: "" })); hava.appendChild(hdot); }
    else havaInit.nodeValue = initials(name);
    if (cfg.headerSubtitle) { subEl.textContent = cfg.headerSubtitle; subEl.style.display = ""; }
    if (cfg.showBranding !== false) { footEl.innerHTML = "⚡ Powered by chat"; footEl.style.display = ""; } else footEl.style.display = "none";
  }
  function agentAvatar() { var cfg = (S.cfg && S.cfg.config) || {}; return cfg.agentAvatarDataUrl || null; }
  function onReady(payload) {
    S.ready = true; applyConfig(payload); emitApi("ready", { conversationId: (payload && payload.conversationId) || null });
    if (S.viewInit) return; S.viewInit = true;
    var cfg = (payload && payload.config) || {}, fields = Array.isArray(cfg.preChatFields) ? cfg.preChatFields : [];
    if (fields.length && !hasThread()) renderForm(fields);
    else { S.formDone = true; composer.style.display = ""; renderWelcome(); }
    restoreDraft();
  }
  function hasThread() { return Object.keys(S.byId).length > 0; }

  function renderForm(fields) {
    composer.style.display = "none";
    var card = el("div", { class: "form" });
    card.appendChild(el("h3", null, "Before we start"));
    card.appendChild(el("p", null, "Share a couple of details and we'll get right back to you."));
    var inputs = [];
    fields.forEach(function (f) {
      var inp = el("input", { type: f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text", placeholder: f.label, "aria-label": f.label }); inp._f = f;
      card.appendChild(el("div", { class: "fld" }, [el("label", null, f.label + (f.required ? " *" : "")), inp])); inputs.push(inp);
    });
    var errEl = el("div", { class: "err" }); errEl.style.display = "none"; card.appendChild(errEl);
    var start = el("button", { class: "rbtn sbtn", style: "width:100%;height:42px;border-radius:12px;font-weight:600" }, "Start chat");
    start.addEventListener("click", function () {
      var pre = {};
      for (var i = 0; i < inputs.length; i++) { var inp = inputs[i], f = inp._f, v = inp.value.trim();
        if (f.required && !v) { errEl.textContent = "Please fill all required fields."; errEl.style.display = ""; inp.focus(); return; }
        if (f.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { errEl.textContent = "Please enter a valid email."; errEl.style.display = ""; inp.focus(); return; }
        if (v) pre[f.type === "email" ? "email" : f.type === "phone" ? "phone" : "name"] = v; }
      S.preChat = pre; S.formDone = true; bodyEl.querySelectorAll(".form").forEach(function (n) { n.remove(); });
      composer.style.display = ""; renderWelcome(); ta.focus();
    });
    card.appendChild(start); bodyEl.appendChild(card); if (inputs[0]) inputs[0].focus();
  }
  function renderWelcome() {
    if (hasThread()) return; var cfg = (S.cfg && S.cfg.config) || {};
    if (cfg.welcomeMessage) appendSys(cfg.welcomeMessage);
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
  function mediaHtml(m) {
    var url = mediaUrl(m.id, false);
    // `sticker` is grouped with `image`: new webp uploads classify as `image`
    // (media-storage `classifyWebpAsImage`), but rows stored BEFORE that fix — and
    // any sticker forwarded from a Meta thread — still carry kind `sticker`. Absent
    // this branch they fell through to the document row, so a photo rendered as a
    // grey 📄 link.
    if (m.media.kind === "image" || m.media.kind === "sticker") return '<div class="media"><img src="' + url + '" alt="image" loading="lazy" data-full="' + url + '"></div>';
    if (m.media.kind === "video") return '<div class="media"><video src="' + url + '" controls preload="metadata"' + (m.media.hasThumbnail ? ' poster="' + mediaUrl(m.id, true) + '"' : "") + "></video></div>";
    if (m.media.kind === "audio") return '<div class="media"><audio src="' + url + '" controls preload="none"></audio></div>';
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
  function mkRow(m, grouped, anim) {
    var isVisitor = m.direction === "in";
    var row = el("div", { class: "mr " + (isVisitor ? "out" : "in") + (grouped ? " grp" : "") });
    if (!isVisitor) {
      var av = el("div", { class: "av" }); var avImg = agentAvatar();
      if (avImg) av.appendChild(el("img", { src: avImg, alt: "" })); else av.appendChild(document.createTextNode(initials(m.senderName)));
      row.appendChild(av);
    }
    var bub = el("div", { class: "bubble" + (anim ? " anim" : ""), html: bubbleHtml(m) });
    var meta = el("div", { class: "meta", html: metaHtml(m, isVisitor) });
    row.appendChild(el("div", { class: "col" }, [bub, meta]));
    if (!m._local && m.externalId) row.appendChild(el("button", { class: "rep", title: "Reply", "aria-label": "Reply", onclick: function () { setReply(m); } }, "↩"));
    row._meta = meta; row._bub = bub;
    wireMedia(bub);
    if (m.id) { S.byId[m.id] = { el: row, msg: m }; trimHistory(); }
    return row;
  }
  function appendBubble(m, opts) {
    opts = opts || {};
    var isVisitor = m.direction === "in";
    var day = fmtDay(m.createdAt);
    if (!S.lastGroup || S.lastGroup.day !== day) bodyEl.appendChild(el("div", { class: "day" }, day));
    var senderKey = isVisitor ? "v" : (m.senderName || "agent");
    var grouped = S.lastGroup && S.lastGroup.sender === senderKey && S.lastGroup.day === day;
    if (!isVisitor && m.senderName && !grouped) bodyEl.appendChild(el("div", { class: "sname" }, m.senderName));
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
    ids
      .map(function (id) { return S.byId[id]; })
      .sort(function (a, b) { return new Date(a.msg.createdAt) - new Date(b.msg.createdAt); })
      .slice(0, ids.length - TRIM_TO)
      .forEach(function (e) {
        if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
        delete S.byId[e.msg.id];
      });
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
      var senderKey = isVisitor ? "v" : (m.senderName || "agent");
      var grouped = grp && grp.sender === senderKey && grp.day === day;
      if (!isVisitor && m.senderName && !grouped) frag.appendChild(el("div", { class: "sname" }, m.senderName));
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
    S.socket.emit("visitor:loadOlder", { before: S.oldestCursor }, function (p) {
      S.loadingOlder = false; earlierBtn.textContent = "Load earlier messages"; earlierBtn.disabled = false;
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
      if (e.el._bub) { var h = bubbleHtml(m); if (e.el._bub.innerHTML !== h) { e.el._bub.innerHTML = h; wireMedia(e.el._bub); } }
      if (e.el._meta) { var mh = metaHtml(m, m.direction === "in"); if (e.el._meta.innerHTML !== mh) e.el._meta.innerHTML = mh; }
      return;
    }
    appendBubble(m, { anim: !quiet });
    if (!quiet && m.direction === "out") { hideTyping(); if (S.socket && S.socket.connected) S.socket.emit("visitor:received"); if (!S.open || document.hidden) { bumpUnread(); playPing(); } else markRead(); }
    // Host-page hook. `quiet` marks a history replay, so a host badge doesn't
    // re-fire for messages the visitor already saw on a reconnect.
    if (!quiet) emitApi("message", { direction: m.direction, body: m.body, hasMedia: !!m.media, createdAt: m.createdAt });
  }
  function applyStatus(id, s) { var e = S.byId[id]; if (e) { e.msg.status = s; if (e.msg.direction === "in" && e.el._meta) e.el._meta.innerHTML = metaHtml(e.msg, true); } }

  function wireMedia(bub) { if (!bub) return; bub.querySelectorAll("img[data-full]").forEach(function (img) { img.onclick = function () { openLightbox(img.getAttribute("data-full")); }; }); }
  function openLightbox(url) { lightbox.innerHTML = ""; lightbox.appendChild(el("img", { src: url, alt: "image" })); lightbox.classList.add("on"); }
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
  bodyEl.addEventListener("click", function (e) {
    var q = e.target && e.target.closest ? e.target.closest(".rq.jump") : null;
    if (!q) return;
    var entry = S.byId[q.getAttribute("data-rq")];
    if (!entry || !entry.el) {
      // Quoted message is older than the loaded window — say so instead of doing
      // nothing, which reads as a broken click.
      return toast("That message is further up — tap “Load earlier”.");
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
  function scrollToBottom(force) { if (force || S.stick) { bodyEl.scrollTop = bodyEl.scrollHeight; newPill.classList.remove("on"); } }
  function onNewRow(isVisitor) { if (isVisitor || S.stick) scrollToBottom(true); else newPill.classList.add("on"); }
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
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { stopFlash(); if (S.open) { clearUnread(); markRead(); } } });

  // ── reply ────────────────────────────────────────────────────────────────────
  function setReply(m) { S.replyTo = { externalId: m.externalId, body: m.media ? (m.media.kind || "attachment") : m.body }; replyQt.textContent = S.replyTo.body || ""; replyBar.classList.add("on"); ta.focus(); }
  function clearReply() { S.replyTo = null; replyBar.classList.remove("on"); }

  var toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("on"); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove("on"); }, 3200); }

  // ── composer ─────────────────────────────────────────────────────────────────
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
  ta.addEventListener("input", function () { autogrow(); updateSend(); if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(function () { lsSet(K.draft, ta.value); }, 300); });
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } });
  ta.addEventListener("focus", function () { ibar.classList.add("focus"); });
  ta.addEventListener("blur", function () { ibar.classList.remove("focus"); });
  sendBtn.addEventListener("click", onSend);
  attachBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () { var f = fileInput.files && fileInput.files[0]; fileInput.value = ""; if (f) stageFile(f); });
  stgClear.addEventListener("click", clearStage);
  function restoreDraft() { var d = lsGet(K.draft); if (d) { ta.value = d; autogrow(); updateSend(); } }
  updateSend();

  // ── outbox ────────────────────────────────────────────────────────────────────
  // "inflight" is persisted AS "queued": the frame was emitted but not yet acked,
  // so a refresh/tab-kill inside the SEND_TIMEOUT window would otherwise drop it
  // from both the UI and storage with no trace (the mobile-flap case). Re-flushing
  // it on next boot is safe — the server dedupes on
  // externalId = widget:visitor:clientMsgId, and retries reuse the same cid.
  function persistOutbox() { var arr = []; for (var cid in S.pending) { var p = S.pending[cid]; if (p.file) continue; if (p.status === "queued" || p.status === "failed" || p.status === "inflight") arr.push({ cid: cid, payload: p.payload, status: p.status === "failed" ? "failed" : "queued" }); } if (arr.length) lsSet(K.outbox, JSON.stringify(arr)); else lsDel(K.outbox); }
  function restoreOutbox() { var raw = lsGet(K.outbox); if (!raw) return; var arr; try { arr = JSON.parse(raw); } catch (_e) { return; } (arr || []).forEach(function (it) { if (it && it.cid && it.payload) optimistic(it.cid, it.payload, null, it.status === "failed" ? "failed" : "queued"); }); }

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
  function idb(cb) {
    var req;
    try { req = indexedDB.open("ccp_wc_" + siteKey, 1); } catch (_e) { return cb(null); }
    req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (_e) {} };
    req.onsuccess = function () { cb(req.result); };
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
          var m = { direction: "in", body: rec.voice ? "🎤 voice message" : "📎 " + (rec.kind || "file"), media: null, status: "queued", createdAt: rec.createdAt || new Date().toISOString(), _local: true };
          var row = appendBubble(m, { anim: false });
          S.pending[cid] = { el: row, payload: rec.payload || { clientMsgId: cid, body: "" }, status: "queued", file: rec.blob, fileName: rec.name, kind: rec.kind, voice: rec.voice, ts: (rec.payload && rec.payload.clientTs) || new Date(rec.createdAt || Date.now()).getTime() };
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
    var p = S.pending[cid]; if (!p || !p.el._meta) return; var meta = p.el._meta;
    if (p.status === "failed") { meta.innerHTML = esc(fmtTime()) + ' <span class="tick err">⚠</span> '; meta.appendChild(el("span", { class: "retry", onclick: function () { retry(cid); } }, "Retry")); }
    else meta.innerHTML = esc(fmtTime()) + " " + tickHtml(p.status);
    if (p.file && (p.status === "queued" || p.status === "inflight") && !p._prog) { p._prog = el("div", { class: "prog" }, el("i")); p.el._bub.appendChild(p._prog); }
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
  function flushOutbox() {
    if (flushing || !S.socket || !S.socket.connected) return;
    var cids = Object.keys(S.pending)
      .filter(function (cid) { var s = S.pending[cid].status; return s === "queued" || s === "inflight"; })
      .sort(function (a, b) { return (S.pending[a].ts || 0) - (S.pending[b].ts || 0); });
    if (!cids.length) return;
    flushing = true;
    var i = 0;
    var next = function () {
      if (i >= cids.length || !S.socket || !S.socket.connected) { flushing = false; return; }
      var cid = cids[i++], p = S.pending[cid];
      if (!p) return next();
      if (p.file) { doUpload(cid, next); return; }
      sendPayload(cid, next);
    };
    next();
  }
  function sendPayload(cid, after) {
    var p = S.pending[cid]; if (!p) return after && after();
    markPending(cid, "inflight");
    var settled = false, advanced = false;
    var go = function () { if (!advanced) { advanced = true; if (after) after(); } };
    var timer = setTimeout(function () {
      if (settled) return;
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
    if (S.closed) { S.closed = false; bodyEl.querySelectorAll(".sys.closed").forEach(function (n) { n.remove(); }); }
    // Remember that this visitor has a thread, so future page loads connect eagerly
    // and agent replies still reach them without opening the panel first.
    lsSet(K.chatted, "1");
    clearReply(); optimistic(cid, payload, null, "queued"); ensureConnected(); persistOutbox(); flushOutbox();
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
    // Caption typed alongside a staged attachment. The server inlines it on this
    // channel (supportsInlineCaption("webchatwidget") === true), so it rides on the
    // same message rather than becoming a second bubble.
    var caption = (opts && opts.caption) || "";
    var payload = { clientMsgId: cid, body: caption.slice(0, 4096), clientTs: Date.now() };
    if (opts && opts.staged && opts.staged.preview) URL.revokeObjectURL(opts.staged.preview);
    if (S.replyTo) payload.replyToExternalId = S.replyTo.externalId; if (S.preChat) { payload.preChat = S.preChat; S.preChat = null; } clearReply();
    var m = { direction: "in", body: caption || (voice ? "🎤 voice message" : "📎 " + kind), media: null, status: "queued", createdAt: new Date().toISOString(), _local: true };
    var row = appendBubble(m, { anim: true }); S.pending[cid] = { el: row, payload: payload, status: "queued", file: file, fileName: file.name, kind: kind, voice: voice, ts: payload.clientTs }; renderPending(cid);
    // Persist the bytes BEFORE attempting the upload, so a refresh mid-upload (or
    // while offline) can still recover the file. Cleared on success in doUpload.
    idbPut(cid, { blob: file, name: file.name, type: file.type, kind: kind, voice: voice, payload: payload, createdAt: m.createdAt });
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
    if (typingRow || S.closed) return; var av = el("div", { class: "av" }); var a = agentAvatar(); if (a) av.appendChild(el("img", { src: a, alt: "" })); else av.appendChild(document.createTextNode("•"));
    typingRow = el("div", { class: "mr in" }, [av, el("div", { class: "col" }, el("div", { class: "bubble", html: '<span class="typ"><i></i><i></i><i></i></span>' }))]);
    bodyEl.appendChild(typingRow); onNewRow(false); emitApi("typing", true);
  }
  function hideTyping() { if (typingRow) { if (typingRow.parentNode) typingRow.parentNode.removeChild(typingRow); typingRow = null; } emitApi("typing", false); }
  function markRead() { if (!S.socket || !S.socket.connected || !S.open || document.hidden) return; if (S.readTimer) return; S.readTimer = setTimeout(function () { S.readTimer = null; if (S.socket && S.socket.connected) S.socket.emit("visitor:read"); }, 400); }

  // Visitor → agent typing (throttled; the agent inbox shows "customer is typing").
  var typingStopTimer = null;
  function emitTyping(on) { if (!S.socket || !S.socket.connected || on === S.typingOn) return; S.typingOn = on; S.socket.emit("visitor:typing", { on: on }); }
  ta.addEventListener("input", function () { emitTyping(true); if (typingStopTimer) clearTimeout(typingStopTimer); typingStopTimer = setTimeout(function () { emitTyping(false); }, 2500); });

  // ── notification sound (opt-in via config.soundEnabled) ──────────────────────
  var audioCtx = null;
  function playPing() {
    var cfg = (S.cfg && S.cfg.config) || {};
    if (!cfg.soundEnabled) return;
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
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recStarting = false;
      // Lost the race (another tap already started a recording, or the user
      // cancelled while the prompt was open): stop this now-orphan stream.
      if (S.recording) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : (MediaRecorder.isTypeSupported("audio/ogg") ? "audio/ogg" : "");
      var mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      var chunks = [];
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
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
          uploadFile(new File([blob], "voice." + ext, { type: blob.type }), { voice: true });
        }
      };
      S.recording = { mr: mr, send: false };
      mr.start(); recStart = Date.now(); micBtn.classList.add("rec"); showRecBar();
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
  function setConn(c) {
    S.conn = c; hdot.className = "hdot" + (c === "online" ? "" : c === "reconnecting" ? " re" : " off");
    reStrip.classList.toggle("on", c === "reconnecting");
    var sub = (S.cfg && S.cfg.config && S.cfg.config.headerSubtitle) || "";
    // "idle" (socket not opened yet, by design) and "connecting" are NOT failures —
    // showing "Offline" for them flashed a scary status the moment a visitor opened
    // the chat. Only a real reconnect/failure gets copy.
    if (!sub) {
      var t = c === "reconnecting" ? "Reconnecting…" : c === "offline" ? "Offline" : "";
      subEl.textContent = t; subEl.style.display = t ? "" : "none";
    }
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
    socket.on("connect", function () { setConn("online"); flushOutbox(); markRead(); });
    socket.on("disconnect", function (reason) { setConn("reconnecting"); hideTyping(); if (reason === "io server disconnect" && !S.fatal) { socket.connect(); } });
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
        appendSys("Chat is unavailable right now. Please try again later.");
        return;
      }
      setConn("reconnecting");
    });
    socket.on("ready", onReady);
    socket.on("history", function (p) {
      var msgs = (p && p.messages) || [];
      // "load earlier" availability travels with every history batch.
      if (!S.oldestCursor && msgs.length) S.oldestCursor = { ts: msgs[0].createdAt, id: msgs[0].id };
      S.hasMore = !!(p && p.hasMore); showEarlier(S.hasMore);
      if (!msgs.length) return;
      S.lastGroup = null; var unseen = 0;
      msgs.forEach(function (m) { var isNew = !(m.id && S.byId[m.id]); upsert(m, true); if (isNew && m.direction === "out" && new Date(m.createdAt).getTime() > S.lastSeenTs) unseen++; });
      S.formDone = true; composer.style.display = ""; dropPills(); lsSet(K.chatted, "1");
      if (unseen && !S.open) { S.unread = 0; for (var i = 0; i < unseen; i++) bumpUnread(); }
      scrollToBottom(false); markRead();
    });
    socket.on("message", function (m) { upsert(m, false); });
    socket.on("message:status", function (p) { if (p && p.id) applyStatus(p.id, p.status); });
    // Safety auto-clear mirrors the agent side (use-typing.ts): if the "off" frame
    // is lost — e.g. the visitor's socket drops while the agent is mid-sentence, so
    // the off is emitted to a room this client already left — the dots would
    // otherwise persist forever (history replay never clears them).
    socket.on("typing", function (p) {
      if (S.typingClear) { clearTimeout(S.typingClear); S.typingClear = null; }
      if (p && p.on) {
        showTyping(); scrollToBottom(false);
        S.typingClear = setTimeout(function () { S.typingClear = null; hideTyping(); }, 8000);
      } else hideTyping();
    });
    socket.on("conversation:status", function (p) { if (p && p.status === "closed") { S.closed = true; appendClosed(); } else if (p && p.status) { S.closed = false; bodyEl.querySelectorAll(".sys.closed").forEach(function (n) { n.remove(); }); } });
  }
  function appendClosed() { if (bodyEl.querySelector(".sys.closed")) return; bodyEl.appendChild(el("div", { class: "sys closed", dir: "auto" }, "This chat was closed. Send a message to continue.")); onNewRow(false); }

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
    s.onerror = function () { S.loadingIo = false; restore(); setConn("offline"); console.error("[webchat] failed to load socket.io client"); };
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
    var wasOpen = !INLINE && lsGet(K.open) === "1";
    var needsLive = INLINE || S.open || wasOpen || !!lsGet(K.chatted) || hasQueued;
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
