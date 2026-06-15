"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@ccp/shared/utils";

/**
 * ISO 3166-1 alpha-2 → flag emoji. Browsers render the two regional-indicator
 * code points as a flag glyph, so we don't need an icon font / image asset.
 */
function flagEmoji(iso: string): string {
  return iso
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

interface Country {
  iso: string;
  name: string;
  /** Dial code without the leading `+`. */
  dial: string;
}

// Curated list — enough to cover the typical pilot/customer mix without
// dragging in a full ISO dataset. Ordered alphabetically by name; the picker
// pins the default country to the top of the visible list.
export const COUNTRIES: Country[] = [
  { iso: "AR", name: "Argentina", dial: "54" },
  { iso: "AU", name: "Australia", dial: "61" },
  { iso: "AT", name: "Austria", dial: "43" },
  { iso: "BH", name: "Bahrain", dial: "973" },
  { iso: "BD", name: "Bangladesh", dial: "880" },
  { iso: "BE", name: "Belgium", dial: "32" },
  { iso: "BR", name: "Brazil", dial: "55" },
  { iso: "CA", name: "Canada", dial: "1" },
  { iso: "CL", name: "Chile", dial: "56" },
  { iso: "CN", name: "China", dial: "86" },
  { iso: "CO", name: "Colombia", dial: "57" },
  { iso: "CY", name: "Cyprus", dial: "357" },
  { iso: "CZ", name: "Czech Republic", dial: "420" },
  { iso: "DK", name: "Denmark", dial: "45" },
  { iso: "EG", name: "Egypt", dial: "20" },
  { iso: "FI", name: "Finland", dial: "358" },
  { iso: "FR", name: "France", dial: "33" },
  { iso: "DE", name: "Germany", dial: "49" },
  { iso: "GH", name: "Ghana", dial: "233" },
  { iso: "GR", name: "Greece", dial: "30" },
  { iso: "HK", name: "Hong Kong", dial: "852" },
  { iso: "IN", name: "India", dial: "91" },
  { iso: "ID", name: "Indonesia", dial: "62" },
  { iso: "IQ", name: "Iraq", dial: "964" },
  { iso: "IE", name: "Ireland", dial: "353" },
  { iso: "IL", name: "Israel", dial: "972" },
  { iso: "IT", name: "Italy", dial: "39" },
  { iso: "JP", name: "Japan", dial: "81" },
  { iso: "JO", name: "Jordan", dial: "962" },
  { iso: "KE", name: "Kenya", dial: "254" },
  { iso: "KW", name: "Kuwait", dial: "965" },
  { iso: "LB", name: "Lebanon", dial: "961" },
  { iso: "MY", name: "Malaysia", dial: "60" },
  { iso: "MX", name: "Mexico", dial: "52" },
  { iso: "MA", name: "Morocco", dial: "212" },
  { iso: "NL", name: "Netherlands", dial: "31" },
  { iso: "NZ", name: "New Zealand", dial: "64" },
  { iso: "NG", name: "Nigeria", dial: "234" },
  { iso: "NO", name: "Norway", dial: "47" },
  { iso: "OM", name: "Oman", dial: "968" },
  { iso: "PK", name: "Pakistan", dial: "92" },
  { iso: "PS", name: "Palestine", dial: "970" },
  { iso: "PH", name: "Philippines", dial: "63" },
  { iso: "PL", name: "Poland", dial: "48" },
  { iso: "PT", name: "Portugal", dial: "351" },
  { iso: "QA", name: "Qatar", dial: "974" },
  { iso: "RO", name: "Romania", dial: "40" },
  { iso: "RU", name: "Russia", dial: "7" },
  { iso: "SA", name: "Saudi Arabia", dial: "966" },
  { iso: "SG", name: "Singapore", dial: "65" },
  { iso: "ZA", name: "South Africa", dial: "27" },
  { iso: "KR", name: "South Korea", dial: "82" },
  { iso: "ES", name: "Spain", dial: "34" },
  { iso: "SE", name: "Sweden", dial: "46" },
  { iso: "CH", name: "Switzerland", dial: "41" },
  { iso: "SY", name: "Syria", dial: "963" },
  { iso: "TW", name: "Taiwan", dial: "886" },
  { iso: "TH", name: "Thailand", dial: "66" },
  { iso: "TN", name: "Tunisia", dial: "216" },
  { iso: "TR", name: "Turkey", dial: "90" },
  { iso: "UA", name: "Ukraine", dial: "380" },
  { iso: "AE", name: "United Arab Emirates", dial: "971" },
  { iso: "GB", name: "United Kingdom", dial: "44" },
  { iso: "US", name: "United States", dial: "1" },
  { iso: "VN", name: "Vietnam", dial: "84" },
  { iso: "YE", name: "Yemen", dial: "967" },
];

/** Default country for new manual contacts. Pilot customer is Lebanon-based. */
export const DEFAULT_COUNTRY_ISO = "LB";

export function findCountry(iso: string): Country | undefined {
  return COUNTRIES.find((c) => c.iso === iso);
}

/**
 * Country dial-code selector. Render INSIDE a relative-positioned wrapper so
 * the dropdown can absolute-position underneath the button.
 *
 * Trade-off: I considered libphonenumber-js for parse/validate, but the API
 * already normalises to digits-only (lib/phone.ts) and rejects bad lengths,
 * so we'd be paying ~150KB for cosmetic gain. Stick with the simple list.
 */
export function CountryCodePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = findCountry(value) ?? findCountry(DEFAULT_COUNTRY_ISO)!;

  // Close on outside click. Avoids the picker hanging around when the agent
  // tabs to another field.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus the search field whenever we open.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.dial.startsWith(q.replace(/^\+/, "")) ||
        c.iso.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-sm font-mono shadow-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
          open && "ring-1 ring-ring",
        )}
      >
        <span className="text-base leading-none">{flagEmoji(current.iso)}</span>
        <span>+{current.dial}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 flex max-h-75 w-65 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
        >
          <div className="border-b border-border px-2.5 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search country or code…"
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
                No matches.
              </div>
            ) : (
              <ul>
                {filtered.map((c) => {
                  const selected = c.iso === current.iso;
                  return (
                    <li key={c.iso}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          onChange(c.iso);
                          setOpen(false);
                          setQuery("");
                        }}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
                          selected && "bg-accent/40",
                        )}
                      >
                        <span className="text-base leading-none">
                          {flagEmoji(c.iso)}
                        </span>
                        <span className="flex-1 truncate">{c.name}</span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          +{c.dial}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
