/* Throwaway wire-shape check for the Messenger calling provider funcs. */
import {
  sendSocialCallAction,
  checkSocialCallPermission,
  requestSocialCallPermission,
  socialCallFeatureEnabled,
} from "@/lib/providers/meta-social";

const MOCK = process.env.META_GRAPH_BASE_URL ?? "http://127.0.0.1:4100";
const opts = { accountId: "PAGE1", accessToken: "tok", graphVersion: "v26.0" };

async function main() {
  await fetch(`${MOCK}/__mock/reset`, { method: "POST" });

  const enabled = await socialCallFeatureEnabled(opts);
  const perm = await checkSocialCallPermission("PSID1", opts);
  const optin = await requestSocialCallPermission("PSID1", opts);
  const connect = await sendSocialCallAction({ action: "connect", to: "PSID1", sdp: "OFFER" }, opts);
  const accept = await sendSocialCallAction({ action: "accept", callId: "c_1", sdp: "OFFER" }, opts);
  const term = await sendSocialCallAction({ action: "terminate", callId: "c_1" }, opts);

  const calls = (await (await fetch(`${MOCK}/__mock/calls`)).json()).calls as Array<{
    method: string; path: string; body: unknown; query: Record<string, string>;
  }>;

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`ok: ${msg}`);
  };

  assert(enabled === true, "feature-status → enabled");
  assert(perm.hasPermission && perm.canStartCall, "permission parsed (has_permission + start_call)");
  assert(optin.messageId.length > 0, "opt-in request returns message id");
  assert(connect.callId === "c_MOCK_1" && connect.sdpAnswer === "MOCK_ANSWER_4", "connect → callId + sdpAnswer");
  assert(accept.sdpAnswer === "MOCK_ANSWER_5" && accept.sdpRenegotiation === "MOCK_RENEG_5", "accept → answer + renegotiation");
  assert(term.callId === undefined, "terminate → no callId");

  const connectCall = calls.find((c) => c.path.endsWith("/calls") && (c.body as { action?: string }).action === "connect");
  assert(!!connectCall, "connect hit /PAGE1/calls");
  assert((connectCall!.body as { platform?: string }).platform === "messenger", "connect body platform=messenger");
  assert(JSON.stringify((connectCall!.body as { session?: unknown }).session) === JSON.stringify({ sdp_type: "offer", sdp: "OFFER" }), "connect body session shape");
  const optinCall = calls.find((c) => c.path.endsWith("/messages"));
  assert(JSON.stringify((optinCall!.body as { message?: { attachment?: { payload?: { template_type?: string } } } }).message?.attachment?.payload?.template_type) === '"calling_optin"', "opt-in template_type=calling_optin");
  const permCall = calls.find((c) => c.path.endsWith("/messenger_call_permissions"));
  assert(permCall!.query.psid === "PSID1", "permission check passes psid in query");

  console.log("\nALL CALLING WIRE-SHAPE CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
