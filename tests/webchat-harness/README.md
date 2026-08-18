# Webchat widget harness

Drives the **real** widget (including the minified build customers receive)
against a mock backend that speaks the actual `/widget` socket protocol — no app,
no database, no Meta. It exists because the widget's hardest bugs are timing and
state bugs (reconnects, offline queues, session resets) that a unit test can't
reach and a full e2e stack makes slow and flaky.

```bash
WIDGET_MIN=1 node tests/webchat-harness/server.mjs     # serve the minified build
npx playwright cli open about:blank
npx playwright cli --raw run-code --filename=tests/webchat-harness/cases/loading.js
```

`server.mjs` exposes `POST /__ctl` to seed config/history, inject frames
(`agentMessage`, `emit`, `disconnect`), and read back what the widget sent
(`received`, `presenceSeen`). Each file in `cases/` is a Playwright page function
returning a JSON array of `{name, pass, detail}`.

Two behaviours the mock copies from the real gateway on purpose, because getting
them wrong makes the widget look broken when it isn't:

- **History is scoped to a visitor id.** A rotated identity (after "End chat")
  gets an empty thread, exactly as the gateway resolves history from the contact.
- **Seeding history adopts the next visitor**, so a fixture planted before the
  test clears `localStorage` isn't wiped by that rotation.

Prefer adding a case here over an assertion in `tests/e2e/webchatwidget/`, which
needs the whole stack; keep that for what genuinely requires the database.
