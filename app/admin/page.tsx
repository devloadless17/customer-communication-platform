import Link from "next/link";
import { Building2, CheckCircle2, ChevronRight, Phone, X } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { listAllTeamsForSuperAdmin } from "@/lib/queries";
import { formatListTime, formatPhone } from "@/lib/utils";

export const metadata = { title: "Organizations · Admin" };
export const dynamic = "force-dynamic";

/**
 * Cross-team browse page. Lists every organization on the platform with
 * aggregate counts and WhatsApp-connected status. Click a row to drill
 * into its members + recent conversations.
 */
export default async function AdminOrganizationsPage() {
  const teams = await listAllTeamsForSuperAdmin();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-8">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every team on the platform.{" "}
            <span className="tabular-nums">{teams.length}</span> total.
          </p>
        </div>
      </header>

      {teams.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
          <Building2 className="size-6 text-muted-foreground" />
          <div className="text-sm font-medium">No organizations yet</div>
          <p className="text-[12px] text-muted-foreground">
            They appear here as soon as the first team gets created.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Organization</th>
                <th className="px-4 py-2.5 text-left font-medium">WhatsApp</th>
                <th className="px-4 py-2.5 text-right font-medium">Members</th>
                <th className="px-4 py-2.5 text-right font-medium">Contacts</th>
                <th className="px-4 py-2.5 text-right font-medium">Chats</th>
                <th className="px-4 py-2.5 text-right font-medium">Messages</th>
                <th className="px-4 py-2.5 text-right font-medium">Broadcasts</th>
                <th className="px-4 py-2.5 text-left font-medium">Created</th>
                <th className="px-4 py-2.5" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-border last:border-b-0 hover:bg-accent/30"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/teams/${t.id}`}
                      className="font-medium text-foreground hover:text-primary"
                    >
                      {t.name}
                    </Link>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {t.id}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {t.whatsappConnected ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-3.5" />
                        {t.whatsappDisplayNumber ? (
                          <span className="font-mono">
                            {formatPhone(t.whatsappDisplayNumber)}
                          </span>
                        ) : (
                          "Connected"
                        )}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        <X className="size-3.5" />
                        Not connected
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {t.userCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.contactCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.conversationCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.messageCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.broadcastCount}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">
                    <LocalTime iso={t.createdAt} format={formatListTime} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/teams/${t.id}`}
                      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Open organization"
                    >
                      <ChevronRight className="size-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        <Phone className="mr-1 inline size-3" />
        Phone numbers shown are the WhatsApp Business numbers each team has connected.
      </p>
    </div>
  );
}
