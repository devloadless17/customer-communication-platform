import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listMessageFlagDefinitionsWithUsage } from "@/lib/api/queries";

import { MessageFlagsSettings } from "@/features/settings/components/message-flags-settings";

export const metadata = { title: "Message flags · Settings" };
export const dynamic = "force-dynamic";

/**
 * Message-flag catalog manager.
 *
 * Message flags are the triage labels an agent (later, the AI) puts on an
 * INDIVIDUAL MESSAGE — "Complaint", "Refund request" — each carrying an
 * open/resolved lifecycle. Deliberately separate from contact Tags, which are
 * segmentation labels on a PERSON and drive broadcast audiences.
 *
 * Gated by the admin-configurable `messageFlags:manage` capability, mirroring
 * `tags:manage`. Note this gates the CATALOG only — raising and resolving a
 * flag is everyday triage and is open to every member.
 *
 * Ships each definition's usage counts so an admin sees what a change affects
 * before confirming. A definition that has ever been used can't be deleted
 * (the history has to stay readable) — the UI steers to Archive instead, and
 * the server enforces it.
 */
export default async function MessageFlagsSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["messageFlags:manage"]) {
    redirect("/account");
  }

  const definitions = await listMessageFlagDefinitionsWithUsage();
  return <MessageFlagsSettings initialDefinitions={definitions} />;
}
