import { redirect } from "next/navigation";

import { api } from "@/lib/api-client";
import { getSession } from "@/lib/auth/current-user";

import { AiAssistantSettings, type AiConfig, type AiDocument } from "./ai-assistant-settings";

export const dynamic = "force-dynamic";

export default async function AiAssistantSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["aiAssistant:manage"]) redirect("/settings/account");

  const [{ config }, { documents }] = await Promise.all([
    api<{ config: AiConfig }>("/api/team/ai-assistant"),
    api<{ documents: AiDocument[] }>("/api/team/ai-assistant/documents"),
  ]);

  return <AiAssistantSettings initialConfig={config} initialDocuments={documents} />;
}
