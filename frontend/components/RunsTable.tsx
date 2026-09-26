"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RunListItem } from "@/lib/api";
import { pct, usd, when } from "@/lib/format";
import { TemplateView } from "./TemplateView";
import { StatusBadge } from "./ui";

function FileChip({ name, kind }: { name: string; kind: "in" | "out" }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${kind === "in" ? "bg-surface-2 text-ink-2" : "bg-good/10 text-good-ink"}`} title={name}>
      <span aria-hidden>{kind === "in" ? "↳" : "⇢"}</span>
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Runs with their prompt, input files, output file, models, and headline metrics. */
export function RunsTable({ runs, compact = false }: { runs: RunListItem[]; compact?: boolean }) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="pb-2 font-medium">Run</th>
            <th className="pb-2 font-medium">Prompt</th>
            <th className="pb-2 font-medium">Input files</th>
            <th className="pb-2 font-medium">Output file</th>
            <th className="pb-2 font-medium">Models</th>
            <th className="pb-2 text-right font-medium">Best acc.</th>
            <th className="pb-2 text-right font-medium">Cost</th>
            <th className="pb-2 text-right font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const total = r.total_inputs * r.models.length;
            const live = r.status === "queued" || r.status === "running";
            return (
              <tr
                key={r.id}
                onClick={() => router.push(`/runs/${r.id}`)}
                className="cursor-pointer border-t border-line align-top hover:bg-surface-2/60"
              >
                <td className="py-2.5 pr-3">
                  <Link href={`/runs/${r.id}`} className="font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>
                    #{r.id} {r.name && <span className="font-normal">{r.name}</span>}
                  </Link>
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    {live && (
                      <span className="tabular text-xs text-ink-2">
                        {r.done}/{total}
                      </span>
                    )}
                  </div>
                </td>
                <td className="max-w-xs py-2.5 pr-3">
                  <div className="font-medium">{r.prompt_name}</div>
                  {!compact && (
                    <div className="mt-1 text-ink-2">
                      <TemplateView template={r.template} clamp />
                    </div>
                  )}
                </td>
                <td className="max-w-[14rem] py-2.5 pr-3">
                  <div className="flex flex-col items-start gap-1">
                    {r.input_files.map((f, i) => (
                      <FileChip key={i} name={f} kind="in" />
                    ))}
                    <span className="tabular text-xs text-muted">{r.total_inputs.toLocaleString()} inputs</span>
                  </div>
                </td>
                <td className="max-w-[14rem] py-2.5 pr-3">
                  <FileChip name={r.output_name} kind="out" />
                </td>
                <td className="max-w-[12rem] py-2.5 pr-3 text-xs text-ink-2">
                  {r.models.slice(0, 3).join(", ")}
                  {r.models.length > 3 && <span className="text-muted"> +{r.models.length - 3}</span>}
                </td>
                <td className="tabular py-2.5 text-right">{pct(r.best_accuracy, 1)}</td>
                <td className="tabular py-2.5 text-right">{usd(r.total_cost_usd)}</td>
                <td className="py-2.5 text-right text-xs text-ink-2">
                  <div className="whitespace-nowrap">{when(r.created_at)}</div>
                  {r.created_by && <div className="text-muted">{r.created_by}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
