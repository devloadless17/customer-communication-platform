"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

/**
 * THE MESSENGER WELCOME SCREEN — the Get Started button, the greeting, and the
 * commands menu. What a person sees before they have ever messaged the Page, as
 * opposed to `EntryPointsPanel`, which is what they see in a chat they've opened.
 *
 * Messenger-only, and a separate panel rather than a section of the entry-points
 * one: Instagram's profile node accepts ice breakers and a persistent menu but
 * rejects all three fields here, so one combined form would offer Instagram admins
 * controls whose save can only 400.
 *
 * Same read-through / write-through posture and the same load-bearing rule as the
 * entry-points panel: when the READ fails we show an error, never an empty form.
 * An empty form invites a save, and an empty save clears what is live — so a
 * transient Graph blip would otherwise delete the Page's Get Started button.
 *
 * One extra hazard worth knowing about: Meta rate-limits this node to 10 calls per
 * 10 minutes PER PAGE, shared with the entry-points panel on the same screen. So
 * this reads once on mount and writes only on save — never on keystroke.
 */
interface Command {
  name: string;
  description: string;
}
interface Welcome {
  getStartedPayload: string | null;
  greeting: string | null;
  commands: Command[];
}

/** Meta's caps. Mirrored from `messenger-profile.ts`, which mirrors the docs. */
const MAX_GREETING = 160;
const MAX_COMMANDS = 10;
const MAX_COMMAND_NAME = 32;
const MAX_COMMAND_DESC = 64;
/** What we set when an admin turns the button on without naming a payload. */
const DEFAULT_GET_STARTED_PAYLOAD = "CCP_GET_STARTED";

export function WelcomeScreenPanel({ accountId }: { accountId?: string }) {
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [getStartedPayload, setGetStartedPayload] = useState<string | null>(null);
  const [greeting, setGreeting] = useState("");
  const [commands, setCommands] = useState<Command[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
      const res = await apiFetch(`/api/workspace/messenger/welcome${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { welcome: Welcome | null };
      if (!body.welcome) {
        setLoadFailed(true);
        return;
      }
      setGetStartedPayload(body.welcome.getStartedPayload);
      setGreeting(body.welcome.greeting ?? "");
      setCommands(body.welcome.commands);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyWelcome(w: Welcome) {
    setGetStartedPayload(w.getStartedPayload);
    setGreeting(w.greeting ?? "");
    setCommands(w.commands);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/workspace/messenger/welcome", {
        method: "POST",
        // apiFetch sets no content-type of its own — say it explicitly or Nest
        // never parses the body.
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(accountId ? { accountId } : {}),
          getStartedPayload,
          greeting: greeting.trim() || null,
          commands,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { welcome?: Welcome | null; detail?: string; error?: string }
        | null;
      if (!res.ok) {
        toast.error(body?.detail ?? body?.error ?? "Couldn't save the welcome screen.");
        return;
      }
      // Show what Meta actually applied, not what we asked for.
      if (body?.welcome) applyWelcome(body.welcome);
      toast.success("Messenger welcome screen updated.");
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  }

  const buttonOn = getStartedPayload !== null;

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Welcome screen</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        What someone sees on Messenger before they&apos;ve ever messaged you. Taps
        arrive in your inbox as normal messages and can trigger a workflow.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Reading the current setup from Messenger…
        </div>
      ) : loadFailed ? (
        // Deliberately NOT an empty form — see the docblock.
        <div className="flex flex-col items-start gap-2 rounded-lg border border-warning-border bg-warning-bg p-3">
          <p className="text-xs text-warning-fg">
            Couldn&apos;t read the current welcome screen from Messenger. Nothing
            is shown rather than an empty form, because saving an empty form would
            erase whatever is live right now.
          </p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-xs font-medium">Get Started button</span>
                <span className="block text-2xs text-muted-foreground">
                  Without it, a first-time visitor gets an empty composer and the
                  greeting below never appears.
                </span>
              </div>
              <Switch
                checked={buttonOn}
                aria-label="Show the Get Started button"
                onCheckedChange={(on) =>
                  setGetStartedPayload(on ? DEFAULT_GET_STARTED_PAYLOAD : null)
                }
              />
            </div>
            {buttonOn && (
              <Input
                value={getStartedPayload ?? ""}
                onChange={(e) => setGetStartedPayload(e.target.value)}
                placeholder={DEFAULT_GET_STARTED_PAYLOAD}
                maxLength={1000}
                className="text-xs"
                aria-label="Get Started payload"
              />
            )}
          </section>

          <section className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Greeting ({greeting.length}/{MAX_GREETING})
            </span>
            <Textarea
              value={greeting}
              onChange={(e) => setGreeting(e.target.value.slice(0, MAX_GREETING))}
              placeholder="Hi! Ask us anything — we usually reply within an hour."
              rows={2}
              className="text-xs"
              aria-label="Greeting text"
            />
            <span className="text-2xs text-muted-foreground">
              Leave empty to remove it.
            </span>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Commands ({commands.length}/{MAX_COMMANDS})
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={commands.length >= MAX_COMMANDS}
                onClick={() => setCommands((prev) => [...prev, { name: "", description: "" }])}
              >
                <Plus className="mr-1 size-3.5" />
                Add
              </Button>
            </div>
            {commands.length === 0 && (
              <p className="text-2xs text-muted-foreground">None set.</p>
            )}
            {commands.map((cmd, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={cmd.name}
                  onChange={(e) =>
                    setCommands((prev) =>
                      // Meta rejects spaces in a command name with an opaque
                      // error, so strip them at the keystroke rather than letting
                      // the save fail.
                      prev.map((x, j) =>
                        j === i
                          ? { ...x, name: e.target.value.replace(/[^a-z0-9_-]/gi, "") }
                          : x,
                      ),
                    )
                  }
                  placeholder="help"
                  maxLength={MAX_COMMAND_NAME}
                  className="w-40 text-xs"
                  aria-label={`Command ${i + 1} name`}
                />
                <Input
                  value={cmd.description}
                  onChange={(e) =>
                    setCommands((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                    )
                  }
                  placeholder="What this does"
                  maxLength={MAX_COMMAND_DESC}
                  className="text-xs"
                  aria-label={`Command ${i + 1} description`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove command ${i + 1}`}
                  onClick={() => setCommands((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </section>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Save to Messenger
            </Button>
            <span className="text-2xs text-muted-foreground">
              Emptying a field clears it on Messenger.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
