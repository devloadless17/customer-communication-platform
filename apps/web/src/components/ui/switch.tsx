import type { ComponentProps, KeyboardEvent, Ref } from "react";

import { cn } from "@ccp/shared/utils";

/**
 * Shared on/off Switch. Controlled via `checked` + `onCheckedChange`. One size,
 * one look across the app: ON = bg-primary (brand), OFF = bg-muted-foreground/30,
 * white thumb, smooth track + thumb transition. Keyboard: Space/Enter toggle.
 *
 * Replaces the hand-rolled `<button role="switch">` toggles that had drifted in
 * track size / on-color / thumb. Spreads native button props, so callers add
 * `aria-label`, `title`, `disabled` etc. directly. React 19: `ref` is a prop.
 */
export interface SwitchProps
  extends Omit<ComponentProps<"button">, "onChange" | "type"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ref?: Ref<HTMLButtonElement>;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  onKeyDown,
  ref,
  ...props
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      ref={ref}
      onClick={() => onCheckedChange(!checked)}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        // Enter already activates a <button>; add Space-parity for switch
        // semantics. Don't preventDefault on Enter or we'd swallow form submits
        // elsewhere — but these are standalone toggles, so guard both keys.
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (!disabled) onCheckedChange(!checked);
        }
        onKeyDown?.(e);
      }}
      className={cn(
        "relative inline-flex h-5.5 w-9.5 shrink-0 cursor-pointer items-center rounded-full outline-hidden transition-colors duration-200",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-4.5 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
