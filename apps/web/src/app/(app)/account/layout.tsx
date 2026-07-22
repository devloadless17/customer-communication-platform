import { SectionShell } from "@/components/layouts/section-shell";
import { AccountSubSidebar } from "@/components/layouts/account-sub-sidebar";

/**
 * Personal settings — you, not your workspace and not your company.
 *
 * Its own section for the same reason Organization has one: the three settings
 * areas answer three different questions, and mixing them is what made the old
 * single /settings page confusing.
 *
 *   /organization → the company: its people, its workspaces
 *   /settings     → THIS workspace: channels, tags, routing, tickets
 *   /account      → you: your profile, your password, your notifications
 *
 * Personal settings notably do NOT change when you switch workspace, which is
 * exactly why they no longer live under the workspace's settings tree.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionShell subSidebar={<AccountSubSidebar />} title="Personal settings">
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 md:px-8 md:py-10">
        {children}
      </div>
    </SectionShell>
  );
}
