# Website chat widget — installation guide

*Hand this to the developer who maintains your website. It takes about five
minutes and needs no build tooling, npm package, or framework.*

Everything below assumes you already created a widget in **Settings → Website
chat** and copied its public key (`wc_pk_…`). The key is **safe to publish** — it
only identifies which chat box to open, and the server independently checks which
domains are allowed to use it.

---

## 1. The one-line install

Paste this once, just before `</body>`, on every page you want the chat on:

```html
<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..." defer></script>
```

That's the whole install. A chat bubble appears in the bottom-right corner.

`defer` matters: it tells the browser to load us *after* your page renders, so we
can never slow your site down.

---

## 2. Choose how it appears

Everything is controlled by `data-` attributes on that same `<script>` tag.

| Attribute | What it does |
|---|---|
| `data-webchat-key` | **Required.** Your widget's public key. |
| `data-webchat-launcher="off"` | Hides the bubble — you open the chat from your own button. |
| `data-webchat-position="left"` | Move the bubble to the bottom-left. |
| `data-webchat-label="Chat with us"` | Adds a text pill next to the bubble. |
| `data-webchat-target="#my-div"` | **Inline mode** — see §3. |
| `data-webchat-api` | Only for local development (see §7). |

### Open the chat from your own button

```html
<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..."
        data-webchat-launcher="off" defer></script>

<a href="#" onclick="CCPWebchat.open(); return false">Chat with us</a>
```

---

## 3. Inline mode — put the chat inside your page

Instead of a floating bubble, the chat can live inside any element you choose: a
support page, a sidebar, or a full-screen chat page.

```html
<div id="ccp-chat" style="height:600px; max-width:440px"></div>

<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..."
        data-webchat-target="#ccp-chat" defer></script>
```

**The chat fills your container, so you control the size with your own CSS.**
That is the one thing to get right — if the container has no height, there is
nothing to fill. For a full-page chat:

```html
<div id="ccp-chat" style="height:100dvh; width:100%"></div>
```

Use `100dvh` rather than `100vh`: on mobile, `100vh` ignores the browser's own
toolbars and pushes the message box off the bottom of the screen.

### React, Next.js, Vue, and other single-page apps

Your container usually doesn't exist yet when the script runs. The widget handles
this automatically — it waits for the element to appear. If you'd rather be
explicit (or your container appears later than 15 seconds):

```jsx
useEffect(() => {
  window.CCPWebchat?.mount("#ccp-chat");
}, []);
```

---

## 4. Controlling it from your own code

```js
CCPWebchat.open();          // open the panel
CCPWebchat.close();
CCPWebchat.toggle();
CCPWebchat.isOpen();        // → true / false
CCPWebchat.mount("#el");    // attach an inline embed (SPAs)
CCPWebchat.unreadCount();   // → number of unread agent replies
```

You can also react to activity — useful if you want to render your *own* unread
badge somewhere in your header:

```js
const off = CCPWebchat.on("unread", (count) => {
  document.querySelector("#my-badge").textContent = count || "";
});
// off() to stop listening
```

Events: `"ready"`, `"message"`, `"unread"`, `"typing"`.

These calls are safe to make before the script finishes loading — they're queued
and replayed.

---

## 5. Restricting which sites can use your widget

In **Settings → Website chat → Allowed domains**, add your domains
(`example.com`, or `*.example.com` for all subdomains).

- Leave it **empty** and any site may embed the widget. Fine while testing.
- Once you add a domain, every other site is refused.
- `localhost` and `127.0.0.1` always work, so local development never needs an
  entry.

Enter hosts, not full URLs — `example.com`, not `https://example.com/support`.
Scheme and port are ignored.

---

## 6. If your site has a Content-Security-Policy

Most sites don't. If yours does, the widget is blocked until you allow it. Add:

```
script-src  https://YOUR-APP;
connect-src https://YOUR-APP wss://YOUR-APP;
img-src     https://YOUR-APP data:;
media-src   https://YOUR-APP;
style-src   'unsafe-inline';
```

`data:` is needed because your agent avatars and logo are embedded directly in the
page rather than fetched. `style-src 'unsafe-inline'` is needed because the
widget's styles live inside its own isolated shadow root.

The exact block, with your real domain filled in, is on the Settings page.

---

## 7. Testing locally

Serve your test page over **HTTP** — open it with a local server (VS Code Live
Server, `python3 -m http.server`), not by double-clicking the file. A page opened
as `file://` has no origin, and the widget refuses to connect.

If you're running this platform locally in development mode, the app and the API
are on two different ports, so you must point the widget at the API explicitly:

```html
<script src="http://localhost:3000/widget.js" data-webchat-key="wc_pk_..."
        data-webchat-api="http://localhost:4000" defer></script>
```

In production both are on one domain and this attribute is not needed.

---

## 8. What your visitors experience

- **Refreshing the page keeps the conversation.** History reloads, the panel
  reopens if it was open, and an unfinished message stays in the box.
- **A dropped connection is recoverable.** Messages typed while offline are
  queued, sent on reconnect, and arrive in the order they were written. Attached
  files survive a refresh too.
- **Strict networks still work.** If a corporate firewall blocks WebSockets, the
  widget automatically falls back to standard HTTP requests.
- **Nothing is shared between visitors.** Each browser gets its own private
  conversation.
- **Clearing browser data starts a new conversation** — the visitor's identity
  lives in their own browser, so a cleared cache, a different device, or a private
  window is a new chat. If you ask for an email or phone in the pre-chat form,
  agents can still connect the two by hand.

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing appears | Check the browser console. `data-webchat-key missing` means the attribute is absent or misspelled. |
| Console: `unknown_site_key` | The key is wrong, or the widget was deleted/deactivated. |
| Console: `origin_not_allowed` | Your domain isn't in **Allowed domains**. Add the host, without `https://`. |
| Console: `target not found` | Inline mode: the selector doesn't match anything. Check the id, or call `CCPWebchat.mount(el)` after your container renders. |
| Inline chat is invisible / zero height | Your container has no height. Give it one (`height:600px` or `height:100dvh`). |
| Stuck on "Reconnecting…" | Usually a network block. The widget retries and falls back to HTTP automatically; if it persists, check `connect-src` in your CSP. |
| Widget works, but not on one page | That page is probably missing the script tag, or a CSP applies only there. |

---

## 10. Performance

The widget is about **35 KB compressed** — roughly a tenth of most commercial chat
widgets. It:

- loads **after** your page renders (`defer`), so it never delays your content;
- opens **no connection at all** for visitors who never open the chat;
- renders inside a **shadow root**, so its styles cannot leak into your site and
  your CSS cannot break it.
