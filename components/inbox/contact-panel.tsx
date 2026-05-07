"use client";

import { Mail, Phone, MapPin, Clock, ExternalLink, FileText } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { avatarGradient } from "@/lib/avatar-color";
import { formatPhone, initials } from "@/lib/utils";
import type { ConversationStatus, ConversationWithRefs } from "@/lib/types";

const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: "Open",
  pending: "Pending",
  closed: "Closed",
};

export function ContactPanel({ data }: { data: ConversationWithRefs }) {
  const { contact, conversation, messages, notes } = data;

  return (
    <aside className="hidden h-full w-[320px] shrink-0 flex-col border-l border-border bg-sidebar text-sidebar-foreground lg:flex">
      <ScrollArea className="flex-1">
        <div className="flex flex-col items-center px-5 pt-6 pb-4">
          <Avatar className="size-16">
            <AvatarFallback
              className="text-lg text-white"
              style={{ backgroundImage: avatarGradient(contact.id) }}
            >
              {initials(contact.name)}
            </AvatarFallback>
          </Avatar>
          <div className="mt-3 text-center">
            <div className="text-base font-semibold">{contact.name}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {formatPhone(contact.phoneNumber)}
            </div>
          </div>
          <div className="mt-3 flex gap-1.5">
            <Badge variant="muted">WhatsApp</Badge>
            <Badge variant="success">Active</Badge>
          </div>
        </div>

        <Separator />

        <Section title="Contact info">
          <DetailRow icon={Phone} label="Phone" value={formatPhone(contact.phoneNumber)} mono />
          <DetailRow icon={Mail} label="Email" value="—" muted />
          <DetailRow icon={MapPin} label="Location" value="—" muted />
          <DetailRow
            icon={Clock}
            label="First contacted"
            value={new Date(messages[0]?.timestamp ?? Date.now()).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          />
        </Section>

        <Separator />

        <Section title="Conversation">
          <DetailRow
            icon={FileText}
            label="Messages"
            value={`${messages.length} · ${notes.length} note${notes.length === 1 ? "" : "s"}`}
          />
          <DetailRow icon={Clock} label="Status" value={STATUS_LABEL[conversation.status]} />
        </Section>

        <Separator />

        <Section title="Recent activity">
          <ul className="space-y-2">
            {messages
              .slice(-4)
              .reverse()
              .map((m) => (
                <li key={m.id} className="flex gap-2 text-xs">
                  <span
                    className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                      m.direction === "in" ? "bg-muted-foreground/60" : "bg-primary"
                    }`}
                  />
                  <span className="line-clamp-2 text-muted-foreground">{m.body}</span>
                </li>
              ))}
          </ul>
        </Section>

        <div className="px-5 py-4">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            View full contact
            <ExternalLink className="size-3" />
          </button>
        </div>
      </ScrollArea>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
  mono,
  muted,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 py-1 text-xs">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 flex-1 truncate ${mono ? "font-mono" : ""} ${
          muted ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
