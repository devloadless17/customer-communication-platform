import { redirect } from "next/navigation";

import { api } from "@/lib/api-client";
import { listContactFieldsWithBuiltins } from "@/lib/api/queries";
import { getSession } from "@/lib/auth/current-user";

import { AiAssistantSettings, type AiConfig, type AiDocument } from "@/features/settings/components/ai-assistant-settings";

export const metadata = {
  title: "AI Assistant · Settings",
};

export const dynamic = "force-dynamic";

export default async function AiAssistantSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["aiAssistant:manage"]) redirect("/account");

  // The contact-field catalog feeds the "details to collect" picker, so an
  // admin can have the assistant fill a field their own workspace defined. The
  // list route is session-authed (only its mutations gate on
  // `contactFields:manage`), so reading it here needs no extra permission.
  const [{ config }, { documents }, { definitions }] = await Promise.all([
    api<{ config: AiConfig }>("/api/workspace/ai-assistant"),
    api<{ documents: AiDocument[] }>("/api/workspace/ai-assistant/documents"),
    listContactFieldsWithBuiltins(),
  ]);

  return (
    <AiAssistantSettings
      initialConfig={config}
      initialDocuments={documents}
      contactFields={definitions.map((d) => ({ key: d.key, label: d.label }))}
    />
  );
}
