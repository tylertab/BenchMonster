import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { RunStatus } from "@/lib/api";

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90",
    secondary: "border border-line bg-surface hover:bg-surface-2",
    ghost: "hover:bg-surface-2 text-ink-2",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

// Status always pairs color with an icon and a label.
const STATUS: Record<RunStatus, { icon: string; label: string; cls: string }> = {
  queued: { icon: "◷", label: "Queued", cls: "text-ink-2 bg-surface-2" },
  running: { icon: "◌", label: "Running", cls: "text-accent bg-accent/10" },
  completed: { icon: "✓", label: "Completed", cls: "text-good-ink bg-good/10" },
  failed: { icon: "✕", label: "Failed", cls: "text-critical bg-critical/10" },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      <span aria-hidden className={status === "running" ? "animate-spin" : ""}>
        {s.icon}
      </span>
      {s.label}
    </span>
  );
}

export function PassBadge({ passed, error }: { passed: boolean | null; error?: string | null }) {
  if (error && !passed) return <span className="text-xs font-medium text-critical">✕ Error</span>;
  return passed ? (
    <span className="text-xs font-medium text-good-ink">✓ Pass</span>
  ) : (
    <span className="text-xs font-medium text-critical">✕ Fail</span>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="rounded-md border border-critical/30 bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted">{children}</p>;
}
