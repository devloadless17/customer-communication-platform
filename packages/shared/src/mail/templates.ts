/**
 * The two emails this product sends.
 *
 * Plain, inline-styled HTML on purpose: Gmail strips `<style>` blocks, Outlook
 * ignores most modern CSS, and a table-free layout with inline styles is the
 * only thing that renders the same in both. No images — an image-only email is
 * blank until the recipient clicks "show images", which is precisely the wrong
 * outcome for a code they need to read.
 *
 * Every template returns BOTH parts. See `SendMailArgs.text` for why.
 */

/** Escape anything interpolated into HTML — org and user names are free text. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0f172a;max-width:520px;margin:0 auto;padding:24px">${bodyHtml}<hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 12px"><p style="font-size:12px;color:#64748b;margin:0">If you weren't expecting this email you can safely ignore it.</p></div>`;
}

export function verificationCodeEmail(args: { code: string; minutes: number }): {
  subject: string;
  html: string;
  text: string;
} {
  const { code, minutes } = args;
  return {
    // The code goes in the SUBJECT as well as the body: on a phone the
    // notification preview is often enough to type it without opening anything.
    subject: `${code} is your verification code`,
    html: shell(
      `<p style="margin:0 0 16px">Enter this code to finish setting up your account:</p>` +
        `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(code)}</p>` +
        `<p style="margin:0;color:#475569">It expires in ${minutes} minutes.</p>`,
    ),
    text: `Enter this code to finish setting up your account:\n\n${code}\n\nIt expires in ${minutes} minutes.\n\nIf you weren't expecting this email you can safely ignore it.`,
  };
}

/**
 * Password-reset code. Separate from `verificationCodeEmail` because the copy
 * has to differ in one way that matters: this email can arrive UNREQUESTED, and
 * when it does it is the only signal the account holder gets that someone is
 * trying to take the account. "Ignore it" is not sufficient — it has to say the
 * password has not changed, so an unexpected code reads as reassurance rather
 * than alarm, and a genuine attempt prompts action.
 */
export function passwordResetCodeEmail(args: { code: string; minutes: number }): {
  subject: string;
  html: string;
  text: string;
} {
  const { code, minutes } = args;
  return {
    subject: `${code} is your password reset code`,
    html: shell(
      `<p style="margin:0 0 16px">Enter this code to choose a new password:</p>` +
        `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(code)}</p>` +
        `<p style="margin:0 0 16px;color:#475569">It expires in ${minutes} minutes.</p>` +
        `<p style="margin:0;color:#475569;font-size:13px">If you didn't ask to reset your password, you can ignore this email — your password hasn't changed.</p>`,
    ),
    text:
      `Enter this code to choose a new password:\n\n${code}\n\n` +
      `It expires in ${minutes} minutes.\n\n` +
      `If you didn't ask to reset your password, you can ignore this email — your password hasn't changed.`,
  };
}

export function inviteEmail(args: {
  url: string;
  workspaceName: string;
  inviterName: string | null;
}): { subject: string; html: string; text: string } {
  const { url, workspaceName, inviterName } = args;
  const who = inviterName ? `${inviterName} invited you` : "You've been invited";
  return {
    subject: `${who} to ${workspaceName}`,
    html: shell(
      `<p style="margin:0 0 16px">${esc(who)} to join <strong>${esc(workspaceName)}</strong>.</p>` +
        `<p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Accept the invite</a></p>` +
        // The raw URL is repeated because "click the button" fails in any
        // client that strips the anchor styling, and because some corporate
        // gateways rewrite links in a way that makes the button untrustworthy.
        `<p style="margin:0;color:#475569;font-size:13px;word-break:break-all">Or paste this into your browser:<br>${esc(url)}</p>`,
    ),
    text: `${who} to join ${workspaceName}.\n\nAccept the invite:\n${url}\n\nIf you weren't expecting this email you can safely ignore it.`,
  };
}
