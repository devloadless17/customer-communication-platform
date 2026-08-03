import { expect, test } from "@playwright/test";

/**
 * An attachment-only reply, through the real composer.
 *
 * The composer has always allowed a screenshot with no caption, but
 * `PostThreadMessageSchema` required `body.min(1)` and the domain refused an
 * empty one — so every caption-less reply 400'd, the optimistic row flipped to
 * "Didn't send", and because no message row was written nobody was notified
 * either (no unread marker, no bell, no blue dot on the rail). One bug, both
 * symptoms, and only reproducible by actually sending a file.
 *
 *   pnpm exec playwright test tests/e2e/post-audit-fixes/ticket-attachment-reply-2026-08-01.spec.ts
 */
test("a file with no caption sends, and the Files gallery picks it up", async ({ page }) => {
  const conv = (await (await page.request.get("/api/conversations?limit=1")).json()) as {
    items?: Array<{ conversation: { id: string } }>;
  };
  const conversationId = conv.items?.[0]?.conversation.id;
  test.skip(!conversationId, "dev DB has no conversation to raise a ticket on");

  const made = await page.request.post("/api/tickets", {
    data: { conversationId, subject: `Attach only ${Date.now()}` },
  });
  const { ticket } = (await made.json()) as { ticket: { id: string } };

  try {
    await page.goto(`/tickets/${ticket.id}`, { timeout: 120_000, waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Thread", exact: true })).toBeVisible({
      timeout: 60_000,
    });

    // Attach WITHOUT typing anything, then send.
    const name = `evidence-${Date.now()}.png`;
    await page.setInputFiles('input[type="file"]', {
      name,
      mimeType: "image/png",
      buffer: Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000180fe8ecf0000000049454e44ae426082",
        "hex",
      ),
    });
    await page.getByRole("button", { name: "Send" }).click();

    // It must NOT fail — this is the exact failure that was reported.
    await expect(page.getByText("Didn't send")).toHaveCount(0, { timeout: 20_000 });
    // `.first()`: an image renders as BOTH a preview link and a filename link.
    await expect(page.getByRole("link", { name }).first()).toBeVisible({ timeout: 20_000 });

    // The server agrees: a real message, empty body, one file.
    const after = (await (await page.request.get(`/api/tickets/${ticket.id}`)).json()) as {
      thread: Array<{ body: string; attachments: Array<{ filename: string }> }>;
      ticket: { attachments: Array<{ filename: string }> };
    };
    expect(after.thread).toHaveLength(1);
    expect(after.thread[0]?.body).toBe("");
    expect(after.thread[0]?.attachments.map((a) => a.filename)).toContain(name);

    // ...and the Files GALLERY lists it, since it now shows every file on the
    // ticket rather than only ones uploaded through a picker that no longer
    // exists.
    expect(after.ticket.attachments.map((a) => a.filename)).toContain(name);
    const gallery = page.locator("section:has(h2:has-text('Files'))");
    await expect(gallery.getByRole("link", { name }).first()).toBeVisible();
    // The uploader is gone — a file arrives WITH the sentence explaining it.
    await expect(gallery.getByText("Add files")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/tickets/${ticket.id}`).catch(() => undefined);
  }
});
