export function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-3">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        {right}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
