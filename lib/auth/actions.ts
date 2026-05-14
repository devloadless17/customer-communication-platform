"use server";

import { signOut } from "@/lib/auth";

// Server action invoked by the sidebar's "Sign out" button.
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
