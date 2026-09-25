"use client";

import { useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  LayoutGrid,
  Phone,
  PhoneCall,
  Reply,
  Workflow,
} from "lucide-react";

import { cn } from "@ccp/shared/utils";
import type { MessageStructured, TemplateSentButton } from "@ccp/shared/types";

type TemplateSnapshot = Extract<MessageStructured, { kind: "template" }>;

const BUTTON_ICON: Record<TemplateSentButton["type"], typeof ExternalLink> = {
  url: ExternalLink,
  phone: Phone,
  quick_reply: Reply,
  copy_code: Copy,
  otp: KeyRound,
  voice_call: PhoneCall,
  catalog: LayoutGrid,
  flow: Workflow,
  other: Reply,
};

/**
 * The part of a sent TEMPLATE that sits below its body: the approved footer and
 * the buttons, laid out the way WhatsApp shows them — so the agent's thread
 * matches what the customer actually received (see lib/templates/sent-snapshot,
 * which captures it at send time).
 *
 * Buttons are the agent's view of the customer's buttons, not controls of their
 * own. A URL or phone button opens what the customer's would, so the agent can
 * check the link they sent; a quick reply is inert, because pressing it is the
 * CUSTOMER's move — its press arrives back as an inbound message.
 */
export function TemplateExtras({
  snapshot,
  isOut,
}: {
  snapshot: TemplateSnapshot;
  isOut: boolean;
}) {
  const divider = isOut ? "border-outbound-fg/20" : "border-border";
  const muted = isOut ? "text-outbound-fg/75" : "text-muted-foreground";
  const accent = isOut ? "text-outbound-fg" : "text-primary";

  return (
    <>
      {snapshot.footer && (
        <p dir="auto" className={cn("px-2.5 pb-1.5 text-xs", muted)}>
          {snapshot.footer}
        </p>
      )}
      {snapshot.buttons && snapshot.buttons.length > 0 && (
        <div className={cn("mt-0.5 border-t", divider)}>
          {snapshot.buttons.map((button, i) => (
            <TemplateButtonRow
              key={`${i}:${button.text}`}
              button={button}
              first={i === 0}
              divider={divider}
              accent={accent}
              muted={muted}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TemplateButtonRow({
  button,
  first,
  divider,
  accent,
  muted,
}: {
  button: TemplateSentButton;
  first: boolean;
  divider: string;
  accent: string;
  muted: string;
}) {
  const Icon = BUTTON_ICON[button.type];
  const row = cn(
    "flex w-full items-center justify-center gap-1.5 px-2.5 py-2 text-sm font-medium",
    !first && "border-t",
    divider,
    accent,
  );
  const label = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{button.text}</span>
    </>
  );

  if (button.type === "url" && button.url) {
    return (
      <a
        href={button.url}
        target="_blank"
        rel="noopener noreferrer"
        title={button.url}
        className={cn(row, "transition-opacity hover:opacity-80")}
      >
        {label}
      </a>
    );
  }
  if (button.type === "phone" && button.phone) {
    return (
      <a
        href={`tel:${button.phone}`}
        title={button.phone}
        className={cn(row, "transition-opacity hover:opacity-80")}
      >
        {label}
      </a>
    );
  }
  if (button.type === "copy_code" && button.code) {
    return <CopyCodeRow code={button.code} className={row} label={label} muted={muted} />;
  }
  // Quick replies, OTP, catalog, flow: shown, not pressable — see the docblock.
  return <div className={row}>{label}</div>;
}

function CopyCodeRow({
  code,
  className,
  label,
  muted,
}: {
  code: string;
  className: string;
  label: React.ReactNode;
  muted: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy the code this message carried"
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
      className={cn(className, "flex-col gap-0.5 transition-opacity hover:opacity-80")}
    >
      <span className="flex items-center gap-1.5">
        {copied ? <Check className="size-3.5 shrink-0" aria-hidden /> : label}
        {copied && <span>Copied</span>}
      </span>
      <span className={cn("font-mono text-xs", muted)}>{code}</span>
    </button>
  );
}
