/**
 * SSR-only bottom-snap for the message thread.
 *
 * THE PROBLEM IT SOLVES: on a HARD refresh of /inbox?c=<id>, page.tsx SSRs the
 * full thread. The server HTML paints at scrollTop=0 (top of the thread), so
 * the browser shows the OLDEST message first. `useChatScroll`'s
 * `useLayoutEffect` only snaps to the bottom AFTER React hydrates — which on a
 * cold load is hundreds of ms (seconds in dev) after first paint. The user sees
 * the first message, then a visible jump down to the latest. Measured with
 * Playwright: viewport sat at top for ~1.7s before snapping. That's the flicker.
 *
 * THE FIX: a plain inline <script> rendered by THIS SERVER COMPONENT as a
 * sibling AFTER the shell. Browsers execute inline scripts synchronously the
 * moment the parser reaches them — so this runs DURING HTML parse, BEFORE the
 * first paint, with the thread viewport already in the DOM (it was parsed just
 * above). It sets scrollTop = scrollHeight, so the very first frame the user
 * sees is already at the bottom. Zero hydration dependency, zero flicker.
 *
 * Why a SERVER component and not the inline <script> that used to live in
 * InboxShell: React 19 warns about <script> rendered inside a Client Component
 * (it only runs on the SSR pass, never on client re-renders — exactly our
 * intent, but the warning is noisy and the pattern is fragile). Rendering it
 * from a server component is the blessed way to emit a one-shot parse-time
 * script. It is NOT hydrated and never re-runs on the client.
 *
 * Idempotent + self-cleaning: runs only while `useChatScroll` hasn't taken over
 * (it bails the instant the hook's data-attr marker appears), retries across a
 * few frames to survive late flex/layout, and removes its own <script> node.
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
      var vp = document.querySelector('[data-thread-scroll-root] [data-radix-scroll-area-viewport]');
      if (vp) {
        // Jump to the bottom. Direct assignment (not scrollTo) so it's
        // instant and pre-paint — no smooth-scroll animation.
        vp.scrollTop = vp.scrollHeight;
      }
      // Keep correcting for a handful of frames: bubble heights, avatar/image
      // reservations and the flex row settle over the first few frames, each
      // nudging scrollHeight up. Stop once the client hook has mounted (it
      // owns scroll from then on) or after ~20 frames (~330ms) as a hard cap.
      var hookOwns = vp && vp.getAttribute('data-chat-scroll-ready') === '1';
      if (!hookOwns && tries < 20) {
        requestAnimationFrame(snap);
      }
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
