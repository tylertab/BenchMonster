"use client";

import Link from "next/link";
import { api, type Run } from "@/lib/api";
import { METHODS } from "./ScoringConfig";
import { TemplateView } from "./TemplateView";
import { Card } from "./ui";

/** What went into a run (prompt snapshot, input files + mappings, scoring) and what came out. */
export function RunMetadata({ run }: { run: Run }) {
  const method = METHODS.find((m) => m.value === run.scoring_method)?.label ?? run.scoring_method;
  const done = run.status === "completed" || run.status === "failed";
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card
        title={
          <span>
            Prompt ·{" "}
            {run.prompt_id ? (
              <Link href={`/prompts/${run.prompt_id}`} className="hover:text-accent">
                {run.prompt_name}
              </Link>
            ) : (
              run.prompt_name
            )}
          </span>
        }
        actions={<span className="text-xs text-muted">as used by this run</span>}
      >
        {run.system_prompt && <p className="mb-2 text-xs text-ink-2">System: {run.system_prompt}</p>}
        <div className="max-h-56 overflow-auto rounded-md bg-surface-2/60 p-3">
          <TemplateView template={run.template} />
        </div>
      </Card>
      <Card title="Files">
        <div className="space-y-3 text-sm">
          <div>
            <div className="mb-1 text-xs text-muted">Inputs</div>
            <ul className="space-y-1.5">
              {run.datasets.map((d) => (
                <li key={d.position}>
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="text-muted">↳</span>
                    {d.dataset_id ? (
                      <Link href={`/datasets/${d.dataset_id}`} className="font-mono hover:text-accent">
                        {d.filename}
                      </Link>
                    ) : (
                      <span className="font-mono">{d.filename}</span>
                    )}
                    <span className="tabular text-xs text-muted">{d.rows} rows</span>
                  </div>
                  <div className="ml-5 flex flex-wrap gap-x-3 text-xs text-ink-2">
                    {Object.entries(d.mapping).map(([v, c]) => (
                      <span key={v}>
                        <code className="text-accent">{`{{${v}}}`}</code> ← {c}
                      </span>
                    ))}
                    {d.expected_column && <span>expected ← {d.expected_column}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Output · scored by {method}</div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="text-good-ink">⇢</span>
              <span className="min-w-0 flex-1 truncate font-mono" title={run.output_name}>
                {run.output_name}
              </span>
              <a
                href={api.predictionsUrl(run.id)}
                download={run.output_name}
                className={`rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:bg-surface-2 ${done ? "" : "opacity-60"}`}
                title={done ? "Download every prediction" : "Download predictions so far"}
              >
                ⬇ Download
              </a>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
