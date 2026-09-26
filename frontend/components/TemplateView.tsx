import { VAR_RE } from "@/lib/template";

/** A prompt template with its {{variables}} highlighted. */
export function TemplateView({ template, clamp }: { template: string; clamp?: boolean }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of template.matchAll(VAR_RE)) {
    parts.push(template.slice(last, m.index));
    parts.push(
      <span key={m.index} className="rounded bg-accent/15 px-0.5 text-accent">
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  parts.push(template.slice(last));
  return <pre className={`whitespace-pre-wrap break-words font-mono text-xs ${clamp ? "line-clamp-2" : ""}`}>{parts}</pre>;
}

export function VariableChips({ variables }: { variables: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {variables.map((v) => (
        <code key={v} className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
          {`{{${v}}}`}
        </code>
      ))}
    </span>
  );
}
