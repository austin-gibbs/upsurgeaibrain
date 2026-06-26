// Nova-grade UI primitives (Tailwind only + lucide-react icons).
import * as React from "react";
import type { LucideIcon } from "lucide-react";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/* ----------------------------- Button ----------------------------- */
type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
  const sizes: Record<ButtonSize, string> = {
    sm: "rounded-xl px-3 py-1.5 text-xs",
    md: "rounded-xl px-4 py-2.5 text-sm",
    lg: "rounded-2xl px-6 py-3 text-sm",
  };
  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-brand-gradient text-white shadow-soft hover:shadow-card hover:brightness-105",
    secondary:
      "bg-surface text-ink-700 border border-ink-200/80 shadow-soft hover:bg-ink-50 hover:shadow-card",
    danger: "bg-accent-rose-fg text-white shadow-soft hover:brightness-110",
    ghost: "bg-transparent text-ink-600 hover:bg-ink-100/80",
  };
  return (
    <button
      className={cn(base, sizes[size], variants[variant], className)}
      {...props}
    />
  );
}

/* ------------------------------ Input ----------------------------- */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-xl border border-ink-200/80 bg-surface px-4 py-2.5 text-sm text-ink-900 shadow-soft placeholder:text-ink-400 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
        className
      )}
      {...props}
    />
  );
});

/* ----------------------------- Select ----------------------------- */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        "w-full rounded-xl border border-ink-200/80 bg-surface px-4 py-2.5 text-sm text-ink-900 shadow-soft transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
});

/* ------------------------------ Label ----------------------------- */
export function Label({
  className,
  children,
  hint,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { hint?: string }) {
  return (
    <label
      className={cn("block text-sm font-medium text-ink-700", className)}
      {...props}
    >
      {children}
      {hint && <span className="ml-1 font-normal text-ink-400">{hint}</span>}
    </label>
  );
}

/* ------------------------------- Card ----------------------------- */
export function Card({
  className,
  hover = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-ink-200/50 bg-surface shadow-card",
        hover && "transition-shadow duration-200 hover:shadow-lifted",
        className
      )}
      {...props}
    />
  );
}

/* ------------------------------ Badge ----------------------------- */
type BadgeTone = "slate" | "green" | "amber" | "red" | "blue";
export function Badge({
  tone = "slate",
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  const tones: Record<BadgeTone, string> = {
    slate: "bg-ink-100 text-ink-600",
    green: "bg-accent-mint-bg text-accent-mint-fg",
    amber: "bg-accent-amber-bg text-accent-amber-fg",
    red: "bg-accent-rose-bg text-accent-rose-fg",
    blue: "bg-accent-sky-bg text-accent-sky-fg",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, BadgeTone> = {
    active: "green",
    draft: "slate",
    paused: "amber",
    completed: "green",
    dialing: "blue",
    queued: "slate",
    failed: "red",
  };
  return <Badge tone={map[status] ?? "slate"}>{status}</Badge>;
}

/* ----------------------------- IconBadge ----------------------------- */
type IconBadgeTone = "mint" | "sky" | "violet" | "amber" | "rose";

export function IconBadge({
  icon: Icon,
  tone = "sky",
  className,
}: {
  icon: LucideIcon;
  tone?: IconBadgeTone;
  className?: string;
}) {
  const tones: Record<IconBadgeTone, string> = {
    mint: "bg-accent-mint-bg text-accent-mint-icon",
    sky: "bg-accent-sky-bg text-accent-sky-icon",
    violet: "bg-accent-violet-bg text-accent-violet-icon",
    amber: "bg-accent-amber-bg text-accent-amber-icon",
    rose: "bg-accent-rose-bg text-accent-rose-icon",
  };
  return (
    <span
      className={cn(
        "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
        tones[tone],
        className
      )}
    >
      <Icon className="h-5 w-5" strokeWidth={1.75} />
    </span>
  );
}

/* ----------------------------- StatTile ----------------------------- */
export function StatTile({
  label,
  value,
  icon,
  tone = "sky",
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  tone?: IconBadgeTone;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
            {label}
          </p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight text-ink-900">
            {value}
          </p>
        </div>
        {icon && <IconBadge icon={icon} tone={tone} className="h-9 w-9" />}
      </div>
    </Card>
  );
}

/* --------------------------- SectionHeader --------------------------- */
export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-ink-900">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-ink-500">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/* ----------------------------- Segmented ----------------------------- */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex rounded-xl bg-ink-100/80 p-1 shadow-soft",
        className
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all duration-200",
            value === opt.value
              ? "bg-surface text-ink-900 shadow-pill"
              : "text-ink-500 hover:text-ink-700"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- Pill ------------------------------- */
export function Pill({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-xs font-medium transition-all duration-200",
        selected
          ? "bg-brand-600 text-white shadow-soft"
          : "bg-ink-100 text-ink-600 hover:bg-ink-200/80"
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------- Tabs ------------------------------- */
export function Tabs({
  items,
  active,
  onSelect,
}: {
  items: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-ink-100 pb-4">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={cn(
            "rounded-xl px-3.5 py-2 text-sm font-medium transition-all duration-200",
            active === item.id
              ? "bg-brand-600 text-white shadow-soft"
              : "bg-ink-100/80 text-ink-600 hover:bg-ink-200/60"
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ SubTabs ------------------------------ */
// Underline-style in-page tabs that swap the content container below them.
export function SubTabs<T extends string>({
  items,
  active,
  onSelect,
  className,
}: {
  items: { id: T; label: string; badge?: React.ReactNode }[];
  active: T;
  onSelect: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-6 flex gap-0.5 overflow-x-auto border-b border-ink-200/60",
        className
      )}
    >
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={cn(
              "-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "border-brand-500 font-semibold text-brand-700"
                : "border-transparent text-ink-500 hover:text-ink-800"
            )}
          >
            {item.label}
            {item.badge !== undefined && item.badge !== null && (
              <span className="rounded-full bg-accent-sky-bg px-2 py-0.5 text-[11px] font-semibold text-accent-sky-fg">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- EmptyState ----------------------------- */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center gap-4 p-12 text-center">
      {Icon && (
        <IconBadge icon={Icon} tone="sky" className="h-12 w-12 rounded-2xl" />
      )}
      <div>
        <p className="font-medium text-ink-700">{title}</p>
        {description && (
          <p className="mt-1 text-sm text-ink-500">{description}</p>
        )}
      </div>
      {action}
    </Card>
  );
}

/* ----------------------------- Skeleton ----------------------------- */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-xl bg-ink-200/60",
        className
      )}
      {...props}
    />
  );
}

/* --------------------------- PageGreeting --------------------------- */
export function PageGreeting({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1.5 text-sm text-ink-500">{subtitle}</p>
      )}
    </div>
  );
}

/* --------------------------- InsightPanel --------------------------- */
export function InsightPanel({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-insight-gradient p-5 text-white shadow-lifted">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{title}</p>
        {action}
      </div>
      <div className="text-sm leading-relaxed text-white/90">{children}</div>
    </div>
  );
}
