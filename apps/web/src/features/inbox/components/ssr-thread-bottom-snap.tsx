/**
 * SSR-only bottom-snap for the message thread.
 *
 * THE PROBLEM IT SOLVES: on a HARD refresh of /inbox?c=<id>, page.tsx SSRs the
 * full thread. The viewport is `flex-direction: column-reverse`, which is
 * SUPPOSED to anchor at the bottom (newest) on first layout with zero JS — but
 * Chromium does NOT reliably initialize a column-reverse box's scroll offset to
 * the bottom on a document load: when the content height is still settling at
 * first layout (web-font swap, avatar/image reservations), the initial offset
 * is computed against the not-yet-final height and the box paints scrolled to
 * the TOP (oldest). `useChatScroll`'s `useLayoutEffect` only corrects it AFTER
 * React hydrates — hundreds of ms after first paint on a cold prod load. The
 * user sees the oldest message + the layout settling, then a visible jump down
 * to the latest. (This is the same flicker the pre-`column-reverse` layout had;
 * the migration to column-reverse removed this script on the assumption native
 * anchoring was enough. It isn't.)
 *
 * THE FIX: a plain inline <script> rendered by THIS SERVER COMPONENT as a
 * sibling AFTER the shell. Browsers execute inline scripts synchronously the
 * moment the parser reaches them — so this runs DURING HTML parse, BEFORE the
 * first paint, with the thread viewport already in the DOM (it was parsed just
 * above). It sets `scrollTop = 0`, which in a column-reverse box IS the bottom
 * (newest); scrolling up toward older goes negative. So the very first frame the
 * user sees is already at the bottom. Zero hydration dependency, zero flicker.
 *
 * Why a SERVER component and not an inline <script> inside a Client Component:
 * React 19 warns about <script> rendered inside a Client Component (it only runs
 * on the SSR pass, never on client re-renders — exactly our intent, but the
 * warning is noisy and the pattern is fragile). Rendering it from a server
 * component is the blessed way to emit a one-shot parse-time script. It is NOT
 * hydrated and never re-runs on the client.
 *
 * Idempotent + self-correcting: re-snaps across a handful of frames so the
 * font-swap / image reflow that nudges the layout can't drift the view, and
 * bails the instant `useChatScroll` marks the viewport ready (`data-chat-scroll-
 * ready="1"`) — from then on the hook owns scroll.
 */
import { headers } from "next/headers";

export async function SsrThreadBottomSnap() {
  // The prod CSP is `script-src 'self' 'nonce-X' 'strict-dynamic'` with NO
  // 'unsafe-inline' (src/proxy.ts). An inline <script> WITHOUT the per-request
  // nonce is silently blocked in prod — works in dev, dead on deploy. Stamp the
  // nonce that proxy.ts put on the request header, same as app/layout.tsx does.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // No template literals with interpolation — this string is static, so there's
  // no XSS surface. It only ever reads/writes the thread viewport's scrollTop.
  const js = `(function(){
    var tries = 0;
    function snap(){
      tries++;
      var vp = document.querySelector('[data-thread-scroll-root]');
      if (vp) {
        // column-reverse: scrollTop 0 IS the bottom (newest); older is negative.
        // Direct assignment (not scrollTo) so it's instant and pre-paint — no
        // smooth-scroll animation. Once the hook has mounted it owns scroll, so
        // we stop correcting.
        if (vp.getAttribute('data-chat-scroll-ready') === '1') return;
        vp.scrollTop = 0;
      }
      // Keep correcting for a handful of frames: the web-font swap and image/
      // avatar reservations settle over the first few frames, each nudging the
      // layout. ~20 frames (~330ms) is a hard cap so we never fight a user who
      // starts scrolling up immediately.
      if (tries < 20) requestAnimationFrame(snap);
    }
    snap();
  })();`;

  // suppressHydrationWarning: the server emits this <script>; the client never
  // renders it (it's a server component), so React must not try to reconcile it.
  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: js }}
    />
  );
}
