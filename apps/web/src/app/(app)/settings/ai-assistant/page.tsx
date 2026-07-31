import { redirect } from "next/navigation";

import { api } from "@/lib/api-client";
import { getSession } from "@/lib/auth/current-user";

import { AiAssistantSettings, type AiConfig, type AiDocument } from "@/features/settings/components/ai-assistant-settings";

export const metadata = {
  title: "AI Assistant · Settings",
};

export const dynamic = "force-dynamic";

export default async function AiAssistantSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["aiAssistant:manage"]) redirect("/account");

  const [{ config }, { documents }] = await Promise.all([
    api<{ config: AiConfig }>("/api/workspace/ai-assistant"),
    api<{ documents: AiDocument[] }>("/api/workspace/ai-assistant/documents"),
  ]);

  return <AiAssistantSettings initialConfig={config} initialDocuments={documents} />;
}
