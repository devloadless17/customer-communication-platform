import { handlers } from "@/lib/auth";

// NextAuth v5 returns Web-standard handlers — wire them directly to the
// catch-all route. Every flow (sign-in, sign-out, callback, csrf) goes
// through here.

export const runtime = "nodejs";

export const { GET, POST } = handlers;
