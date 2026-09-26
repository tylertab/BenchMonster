"use client";

import Link from "next/link";
import type { ProfileVersion } from "@/lib/api";
import { METHODS } from "./ScoringConfig";
import { TemplateView, VariableChips } from "./TemplateView";
import { FormatBadge } from "./InputSetEditor";
import { Card } from "./ui";

function DatasetLink({ id, available, filename }: { id: number | null; available: boolean; filename: string }) {
  return available && id ? (
    <Link href={`/datasets/${id}`} className="font-mono hover:text-accent">
      {filename}
    </Link>
  ) : (
    <span className="font-mono text-critical" title="This dataset was deleted">
      {filename} (deleted)
    </span>
  );
}

/** Read-only view of one profile version: prompt, input sets, output expectations, models. */
export function ProfileConfigView({ v }: { v: ProfileVersion }) {
  const method = METHODS.find((m) => m.value === v.scoring_method)?.label ?? v.scoring_method;
  const cfg = v.scoring_config as Record<string, unknown>;
  return (
    <div className="space-y-6">
      <Card title={`Prompt · ${v.prompt_name}`} actions={<VariableChips variables={v.variables} />}>
        {v.system_prompt && <p className="mb-2 text-xs text-ink-2">System: {v.system_prompt}</p>}
        <div className="max-h-80 overflow-auto rounded-md bg-surface-2/60 p-3">
          <TemplateView template={v.template} />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Inputs & expected outputs">
          <ul className="space-y-3 text-sm">
            {v.datasets.map((d) => (
              <li key={d.position} className="rounded-md border border-line p-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-16 text-xs text-muted">Input</span>
                  <FormatBadge format={d.format} />
                  <DatasetLink id={d.dataset_id} available={d.available} filename={d.filename} />
                  {d.row_count != null && <span className="tabular text-xs text-muted">{d.row_count.toLocaleString()} rows</span>}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="w-16 text-xs text-muted">Expected</span>
                  {d.expected_dataset_id ? (
                    <>
                      <FormatBadge format={d.expected_format} />
                      <DatasetLink id={d.expected_dataset_id} available={d.expected_available} filename={d.expected_filename ?? "?"} />
                    </>
                  ) : d.expected_column ? (
                    <span className="text-xs">
                      column <code>{d.expected_column}</code> of the input file
                    </span>
                  ) : (
                    <span className="text-xs text-muted">none</span>
                  )}
                </div>
                {d.expected_dataset_id && (
                  <div className="ml-[4.5rem] mt-0.5 text-xs text-ink-2">
                    matched {d.input_key ? `on ${d.input_key} = ${d.expected_key}` : "by row order"} · expected value: {d.expected_column ? `column ${d.expected_column}` : "whole row as JSON"}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Comparison">
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted">Scoring</dt>
              <dd>{method}</dd>
            </div>
            {Array.isArray(cfg.fields) && (
              <div>
                <dt className="text-xs text-muted">Fields</dt>
                <dd className="font-mono text-xs">{(cfg.fields as string[]).join(", ")}</dd>
              </div>
            )}
            {cfg.schema != null && (
              <details>
                <summary className="cursor-pointer text-xs text-muted">Output schema</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-2/60 p-2 font-mono text-xs">{JSON.stringify(cfg.schema, null, 2)}</pre>
              </details>
            )}
            {typeof cfg.rubric === "string" && (
              <div>
                <dt className="text-xs text-muted">Rubric</dt>
                <dd className="text-xs">{cfg.rubric}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>

      <Card
        title={`Execution · ${v.params.mode === "batch" ? `batch, ${v.params.batch_size} inputs per request` : "real-time"} · ${v.models.length} model${v.models.length === 1 ? "" : "s"}`}
        actions={<span className="text-xs text-muted">max_tokens {v.params.max_tokens} · temperature {v.params.temperature} · concurrency {v.params.concurrency}</span>}
      >
        <div className="flex flex-wrap gap-1.5">
          {v.models.map((m) => (
            <span key={m.id} className={`rounded-md border border-line px-2 py-1 text-xs ${m.active ? "" : "text-muted line-through"}`} title={m.model_id}>
              {m.display_name}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
