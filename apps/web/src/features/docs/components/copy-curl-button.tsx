"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { toast } from "@/lib/toast";

type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

interface Props {
  method: Method;
  /** Path-only, e.g. `/api/external/v1/contacts/upsert`. May contain `:id` placeholders. */
  path: string;
  /** JSON request body. Sent compact-stringified in `-d`. */
  body?: Record<string, unknown>;
  /** Extra headers beyond Authorization + Content-Type. */
  headers?: Record<string, string>;
}

export function CopyCurlButton({ method, path, body, headers }: Props) {
  const [copied, setCopied] = useState(false);

  function copy() {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const lines = [
      `curl -X ${method} '${origin}${path}' \\`,
      `  -H 'Authorization: Bearer $CCP_TOKEN'`,
    ];
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        lines[lines.length - 1] += " \\";
        lines.push(`  -H '${k}: ${v}'`);
      }
    }
    if (body) {
      lines[lines.length - 1] += " \\";
      lines.push(`  -H 'Content-Type: application/json' \\`);
      lines.push(`  -d '${JSON.stringify(body)}'`);
    }
    const cmd = lines.join("\n");
    void navigator.clipboard.writeText(cmd).then(
      () => {
        setCopied(true);
        toast.success("curl copied");
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error("Couldn't access clipboard"),
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      title="Copy curl with $CCP_TOKEN placeholder"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      curl
    </button>
  );
}
