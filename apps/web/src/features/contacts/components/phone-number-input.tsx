"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";

import {
  COUNTRIES,
  CountryCodePicker,
  DEFAULT_COUNTRY_ISO,
  findCountry,
} from "./country-code-picker";

/**
 * Two-part phone entry: a country dial-code picker (`+961 ▾`) next to a
 * local-digits field. Emits ONE E.164 string ("+96171505894") via `onChange`,
 * or "" when the local part is empty. Splitting the country code out means the
 * agent never has to wonder whether to type the "+" or the prefix — the picker
 * owns it.
 *
 * Controlled by `value` (E.164). Internal iso/local state is seeded from it
 * and re-synced ONLY when `value` changes to something we didn't just emit
 * (an external change — e.g. switching workflow nodes), so the caret never
 * jumps while the user types.
 */
function splitE164(value: string | null | undefined): { iso: string; local: string } {
  const digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return { iso: DEFAULT_COUNTRY_ISO, local: "" };
  // Longest dial-code prefix wins so +961 beats +9 / +96.
  const match = [...COUNTRIES]
    .sort((a, b) => b.dial.length - a.dial.length)
    .find((c) => digits.startsWith(c.dial));
  if (match) return { iso: match.iso, local: digits.slice(match.dial.length) };
  return { iso: DEFAULT_COUNTRY_ISO, local: digits };
}

function buildE164(iso: string, local: string): string {
  const digits = local.replace(/\D/g, "");
  if (!digits) return "";
  const country = findCountry(iso);
  return country ? `+${country.dial}${digits}` : `+${digits}`;
}

export function PhoneNumberInput({
  value,
  onChange,
  disabled,
  placeholder = "70 921 116",
  autoFocus,
}: {
  value: string;
  onChange: (e164: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const initial = splitE164(value);
  const [iso, setIso] = useState(initial.iso);
  const [local, setLocal] = useState(initial.local);

  // Adopt an EXTERNAL value change only. If `value` already equals what we'd
  // emit, it's our own echo — leave the fields (and caret) untouched.
  useEffect(() => {
    if ((value ?? "") !== buildE164(iso, local)) {
      const next = splitE164(value);
      setIso(next.iso);
      setLocal(next.local);
    }
    // Intentionally keyed on `value` only — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function update(nextIso: string, nextLocal: string) {
    setIso(nextIso);
    setLocal(nextLocal);
    onChange(buildE164(nextIso, nextLocal));
  }

  return (
    <div className="flex items-stretch gap-2">
      <CountryCodePicker
        value={iso}
        onChange={(nextIso) => update(nextIso, local)}
        disabled={disabled}
      />
      <Input
        value={local}
        onChange={(e) => update(iso, e.target.value)}
        placeholder={placeholder}
        inputMode="tel"
        autoFocus={autoFocus}
        disabled={disabled}
        className="flex-1 font-mono"
      />
    </div>
  );
}
