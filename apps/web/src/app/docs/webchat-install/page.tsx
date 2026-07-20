import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata = { title: "Website chat — installation guide" };

/**
 * Installation guide an organization hands to their own web developer.
 *
 * Public (like /docs/api) — it contains nothing sensitive, the site key is
 * public by design, and a developer may need to read it before they have an
 * account. Deliberately written for someone who has never seen this platform:
 * no build tooling, no npm package, one script tag.
 *
 * The prose twin lives at docs/webchat-install-guide.md for internal reference;
 * keep the two in step when the embed contract changes.
 */
export default function WebchatInstallDocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 md:py-10">
      <Link
        href="/settings/webchatwidget"
        className="mb-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        Back to Website chat
      </Link>

      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Installing the chat widget</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For the developer who maintains your website. About five minutes — no build
          tooling, no npm package. Get your public key (<code className="rounded bg-muted px-1 text-xs">wc_pk_…</code>)
          from Settings → Website chat. It is safe to publish: it only says which chat
          box to open, and the server separately checks which domains may use it.
        </p>
      </header>

      <Section title="1. The one-line install">
        <P>Paste this once, just before <Code>&lt;/body&gt;</Code>, on every page:</P>
        <Pre>{`<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..." defer></script>`}</Pre>
        <P>
          That is the whole install — a chat bubble appears bottom-right.{" "}
          <Code>defer</Code> is important: it loads the widget <em>after</em> your page
          renders, so it can never slow your site down.
        </P>
      </Section>

      <Section title="2. Choose how it appears">
        <P>Everything is controlled by attributes on that same script tag.</P>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-2 pr-4 font-semibold">Attribute</th>
              <th className="py-2 font-semibold">What it does</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            {[
              ["data-webchat-key", "Required. Your widget's public key."],
              ["data-webchat-launcher=\"off\"", "Hides the bubble — you open the chat from your own button."],
              ["data-webchat-position=\"left\"", "Move the bubble to the bottom-left."],
              ["data-webchat-label=\"Chat with us\"", "Adds a text pill beside the bubble."],
              ["data-webchat-target=\"#my-div\"", "Inline mode — see section 3."],
              ["data-webchat-api", "Local development only (section 7)."],
            ].map(([a, d]) => (
              <tr key={a} className="border-b border-border/50 align-top">
                <td className="py-2 pr-4"><code className="text-3xs text-foreground">{a}</code></td>
                <td className="py-2">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <P className="mt-4">Opening the chat from your own button:</P>
        <Pre>{`<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..."
        data-webchat-launcher="off" defer></script>

<a href="#" onclick="CCPWebchat.open(); return false">Chat with us</a>`}</Pre>
      </Section>

      <Section title="3. Inline — put the chat inside your page">
        <P>
          Instead of a floating bubble, the chat can live inside any element: a support
          page, a sidebar, or a full-screen chat page.
        </P>
        <Pre>{`<div id="ccp-chat" style="height:600px; max-width:440px"></div>

<script src="https://YOUR-APP/widget.js" data-webchat-key="wc_pk_..."
        data-webchat-target="#ccp-chat" defer></script>`}</Pre>
        <Callout>
          <strong>The chat fills your container, so you choose the size.</strong> This is
          the one thing to get right — a container with no height has nothing to fill,
          and the chat will look like it failed to load.
        </Callout>
        <P className="mt-4">For a full-page chat:</P>
        <Pre>{`<div id="ccp-chat" style="height:100dvh; width:100%"></div>`}</Pre>
        <P>
          Use <Code>100dvh</Code> rather than <Code>100vh</Code>: on mobile,{" "}
          <Code>100vh</Code> ignores the browser&apos;s own toolbars and pushes the
          message box off the bottom of the screen.
        </P>
        <P className="mt-3">
          The embedded chat takes the corner shape of your container, and for a
          full-page help centre you can hide its header entirely under{" "}
          <strong>Settings → Website chat → Behavior → Show chat header</strong> for a
          bare “just chat” surface. Not sure which layout you want?{" "}
          <strong>“Test this widget on a sample page”</strong> in Settings shows the
          bubble, inline, and full-page modes live before you install.
        </P>
        <h3 className="mt-5 text-sm font-semibold">React, Next.js, Vue</h3>
        <P>
          Your container usually doesn&apos;t exist yet when the script runs. The widget
          waits for it automatically — but you can mount explicitly:
        </P>
        <Pre>{`useEffect(() => {
  window.CCPWebchat?.mount("#ccp-chat");
}, []);`}</Pre>
      </Section>

      <Section title="4. Controlling it from your code">
        <Pre>{`CCPWebchat.open();          // open the panel
CCPWebchat.close();
CCPWebchat.toggle();
CCPWebchat.isOpen();        // → true / false
CCPWebchat.mount("#el");    // attach an inline embed (SPAs)
CCPWebchat.unreadCount();   // → unread agent replies`}</Pre>
        <P>Render your own unread badge anywhere on your site:</P>
        <Pre>{`const off = CCPWebchat.on("unread", (count) => {
  document.querySelector("#my-badge").textContent = count || "";
});`}</Pre>
        <P>
          Events: <Code>ready</Code>, <Code>message</Code>, <Code>unread</Code>,{" "}
          <Code>typing</Code>. All calls are safe before the script finishes loading —
          they are queued and replayed.
        </P>
      </Section>

      <Section title="5. Restricting which sites can use it">
        <P>
          In <strong>Settings → Website chat → Allowed domains</strong>, add your
          domains (<Code>example.com</Code>, or <Code>*.example.com</Code> for all
          subdomains).
        </P>
        <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
          <li>Empty = any site may embed it. Fine while testing.</li>
          <li>Add one domain and every other site is refused.</li>
          <li><Code>localhost</Code> always works, so local development needs no entry.</li>
        </ul>
        <P className="mt-3">
          Enter hosts, not URLs — <Code>example.com</Code>, not{" "}
          <Code>https://example.com/support</Code>. Scheme and port are ignored.
        </P>
      </Section>

      <Section title="6. If your site sets a Content-Security-Policy">
        <P>Most sites don&apos;t. If yours does, allow these or the widget is blocked:</P>
        <Pre>{`script-src  https://YOUR-APP;
connect-src https://YOUR-APP wss://YOUR-APP;
img-src     https://YOUR-APP data:;
media-src   https://YOUR-APP;
style-src   'unsafe-inline';`}</Pre>
        <P>
          <Code>data:</Code> is needed because agent avatars are embedded in the page
          rather than fetched. <Code>&apos;unsafe-inline&apos;</Code> styles are needed
          because the widget&apos;s CSS lives inside its own isolated shadow root — it
          cannot affect your page. The Settings page shows this block with your real
          domain filled in.
        </P>
      </Section>

      <Section title="7. Testing locally">
        <P>
          Serve your test page over <strong>HTTP</strong> — use a local server (VS Code
          Live Server, <Code>python3 -m http.server</Code>), not by double-clicking the
          file. A <Code>file://</Code> page has no origin and the widget will refuse to
          connect.
        </P>
      </Section>

      <Section title="8. What your visitors experience">
        <ul className="ml-4 list-disc space-y-1.5 text-sm text-muted-foreground">
          <li><strong>Refreshing keeps the conversation</strong> — history reloads, the panel reopens if it was open, and an unfinished message stays in the box.</li>
          <li><strong>A dropped connection recovers</strong> — messages typed offline are queued, sent on reconnect, and arrive in the order written. Attached files survive a refresh too.</li>
          <li><strong>Strict networks still work</strong> — if a corporate firewall blocks WebSockets, the widget falls back to ordinary HTTP automatically.</li>
          <li><strong>Clearing browser data starts a new conversation</strong> — the visitor&apos;s identity lives in their browser, so a cleared cache, another device, or a private window is a new chat. If you collect an email or phone in the pre-chat form, agents can still connect the two.</li>
        </ul>
      </Section>

      <Section title="9. Troubleshooting">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-2 pr-4 font-semibold">Symptom</th>
              <th className="py-2 font-semibold">Cause</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            {[
              ["Nothing appears", "Check the browser console. “data-webchat-key missing” means the attribute is absent or misspelled."],
              ["Console: unknown_site_key", "The key is wrong, or the widget was deleted or deactivated."],
              ["Console: origin_not_allowed", "Your domain isn't in Allowed domains. Add the host, without https://."],
              ["Console: target not found", "Inline mode: the selector matches nothing. Check the id, or call CCPWebchat.mount(el) after your container renders."],
              ["Inline chat invisible / zero height", "Your container has no height. Give it one (height:600px, or 100dvh)."],
              ["Stuck on “Reconnecting…”", "Usually a network block. The widget retries and falls back to HTTP; if it persists, check connect-src in your CSP."],
            ].map(([s, c]) => (
              <tr key={s} className="border-b border-border/50 align-top">
                <td className="py-2 pr-4 text-foreground">{s}</td>
                <td className="py-2">{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="10. Performance">
        <P>
          The widget is about <strong>35 KB compressed</strong> — roughly a tenth of most
          commercial chat widgets. It loads <em>after</em> your page renders, opens no
          connection at all for visitors who never open the chat, and renders inside a
          shadow root so its styles cannot leak into your site and your CSS cannot break
          it.
        </P>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-sm text-muted-foreground ${className}`}>{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 text-xs text-foreground">{children}</code>;
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-3xs leading-relaxed text-foreground">
      <code>{children}</code>
    </pre>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
