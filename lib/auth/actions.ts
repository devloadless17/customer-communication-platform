"use server";

import { redirect } from "next/navigation";

import { signOutCurrentSession } from "@/lib/auth";

// Server action invoked by the sidebar's "Sign out" button. The sidebar
// closes the websocket BEFORE calling this so other tabs see the user go
// offline immediately — see components/inbox/sidebar.tsx.
export async function signOutAction() {
  await signOutCurrentSession();
  redirect("/login");
}
