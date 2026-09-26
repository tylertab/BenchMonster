"use client";

import Link from "next/link";
import type { ProfileVersion } from "@/lib/api";
import { METHODS } from "./ScoringConfig";
import { TemplateView, VariableChips } from "./TemplateView";
import { Card } from "./ui";

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
        <Card title="Input sets">
          <ul className="space-y-3 text-sm">
            {v.datasets.map((d) => (
              <li key={d.position}>
                <div className="flex items-center gap-2">
                  <span aria-hidden className="text-muted">↳</span>
                  {d.available ? (
                    <Link href={`/datasets/${d.dataset_id}`} className="font-mono hover:text-accent">
                      {d.filename}
                    </Link>
                  ) : (
                    <span className="font-mono text-critical" title="This dataset was deleted">
                      {d.filename} (deleted)
                    </span>
                  )}
                  {d.row_count != null && <span className="tabular text-xs text-muted">{d.row_count.toLocaleString()} rows</span>}
                </div>
                <div className="ml-5 mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-2">
                  {Object.entries(d.mapping).map(([k, c]) => (
                    <span key={k}>
                      <code className="text-accent">{`{{${k}}}`}</code> ← {c}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Output expectations">
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted">Expected output</dt>
              <dd>
                {v.datasets.map((d) => (
                  <div key={d.position} className="text-xs">
                    <span className="font-mono">{d.filename}</span> · {d.expected_column ? <code>{d.expected_column}</code> : <span className="text-muted">none</span>}
                  </div>
                ))}
              </dd>
            </div>
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

      <Card title={`Models (${v.models.length})`} actions={<span className="text-xs text-muted">max_tokens {v.params.max_tokens} · temperature {v.params.temperature} · concurrency {v.params.concurrency}</span>}>
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
