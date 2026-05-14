"use client";

export function ReadOnlyRow({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 py-1 text-xs">
      {Icon ? (
        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
