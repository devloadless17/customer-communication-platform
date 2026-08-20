"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@ccp/shared/utils";

/**
 * A date / datetime-local input that is never rendered EMPTY.
 *
 * Safari (16+, macOS and iOS alike) paints ghost text — the current date or
 * time — inside an empty date/time input instead of a placeholder, and makes
 * the empty control non-editable until it has a value. So an unset filter
 * looked applied ("filtered to today" that filters nothing), and an unset
 * required field looked filled while it silently blocked the submit button.
 * Chrome shows an honest `--:--` / `mm/dd/yyyy`; Safari lies. (Apple forums
 * #728067 — the same WebKit bug class the AI-assistant weekly schedule hit.)
 *
 * The cure is structural, not CSS-into-the-shadow-DOM: while the value is
 * empty this renders a plain BUTTON naming the empty state ("Any date",
 * "Set expiry"); clicking seeds a real value and swaps the actual input in,
 * focused. Clearing the field swaps the button back. No empty native
 * date/time control ever reaches the screen, on any browser.
 */
export function GhostSafeDateInput({
  type,
  value,
  onChange,
  seed,
  emptyLabel,
  className,
  buttonClassName,
  ...inputProps
}: {
  type: "date" | "datetime-local";
  value: string;
  onChange: (next: string) => void;
  /** The value the input starts from when the person opts in. */
  seed: () => string;
  /** What the control says while unset — name the REST state, e.g. "Any date". */
  emptyLabel: string;
  className?: string;
  /** Styling for the empty-state button; defaults to the input's classes. */
  buttonClassName?: string;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "className"
>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [justSeeded, setJustSeeded] = useState(false);

  // Focus lands on the input on the render AFTER seeding, once it exists.
  useEffect(() => {
    if (!justSeeded) return;
    setJustSeeded(false);
    inputRef.current?.focus();
  }, [justSeeded]);

  if (value === "") {
    return (
      <button
        type="button"
        className={cn(
          "text-left text-muted-foreground",
          buttonClassName ?? className,
        )}
        onClick={() => {
          onChange(seed());
          setJustSeeded(true);
        }}
        {...(inputProps["aria-label"] ? { "aria-label": inputProps["aria-label"] } : {})}
        {...(inputProps.id ? { id: inputProps.id } : {})}
      >
        {emptyLabel}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      {...inputProps}
    />
  );
}

/** Today as the `YYYY-MM-DD` a date input wants, in the viewer's own zone. */
export function todayDateValue(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local wall-clock `YYYY-MM-DDTHH:mm` for a datetime-local input, `hoursAhead` from now. */
export function localDateTimeValue(hoursAhead = 0): string {
  const d = new Date(Date.now() + hoursAhead * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
