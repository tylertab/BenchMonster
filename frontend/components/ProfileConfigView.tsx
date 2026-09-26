"use client";

import Link from "next/link";
import type { ProfileVersion } from "@/lib/api";
import { FormatBadge } from "./InputSetEditor";
import { METHODS } from "./ScoringConfig";
import { TemplateView, VariableChips } from "./TemplateView";
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

function describeExtract(ex: Record<string, unknown> | undefined): string {
  if (!ex || ex.type === "none" || !ex.type) return "Use the reply as is (trimmed)";
  if (ex.type === "json_field") return `Take JSON field "${ex.path}" from the reply`;
  if (ex.type === "regex") return `Extract with regex /${ex.pattern}/${ex.group != null ? ` (group ${ex.group})` : ""}`;
  return String(ex.type);
}

/** Read-only view of one profile version, in the same order as the editor. */
export function ProfileConfigView({ v }: { v: ProfileVersion }) {
  const method = METHODS.find((m) => m.value === v.scoring_method)?.label ?? v.scoring_method;
  const cfg = v.scoring_config as Record<string, unknown>;
  const batch = v.params.mode === "batch";
  return (
    <div className="space-y-6">
      <Card title="Run mode">
        <p className="text-sm">
          {batch ? (
            <>
              <strong>Batch</strong> · {v.params.batch_size} inputs packed per request; the model returns a JSON array of answers.
            </>
          ) : (
            <>
              <strong>Real-time</strong> · one streaming request per input, in parallel.
            </>
          )}
        </p>
      </Card>

      <Card title={`Prompt · ${v.prompt_name}`} actions={<VariableChips variables={v.variables} />}>
        {v.system_prompt && <p className="mb-2 text-xs text-ink-2">System: {v.system_prompt}</p>}
        <div className="max-h-80 overflow-auto rounded-md bg-surface-2/60 p-3">
          <TemplateView template={v.template} />
        </div>
      </Card>

      <Card title="Inputs" actions={<span className="text-xs text-muted">where each variable&apos;s value comes from</span>}>
        <div className="space-y-3 text-sm">
          <table className="w-full text-sm">
            <tbody>
              {v.variables.map((name) => {
                const b = v.bindings?.[name];
                const whole = v.datasets.some((d) => d.mapping[name] === "$record");
                return (
                  <tr key={name} className="border-t border-line first:border-0 align-top">
                    <td className="w-40 py-1.5">
                      <code className="text-accent">{`{{${name}}}`}</code>
                    </td>
                    <td className="py-1.5 text-ink-2">
                      {b?.type === "text" ? (
                        <>
                          value: <span className="text-ink">{b.value.length > 120 ? `${b.value.slice(0, 120)}…` : b.value}</span>
                        </>
                      ) : b?.type === "dataset" ? (
                        <>dataset <span className="font-mono text-ink">{v.display_bindings?.[name]?.filename ?? `dataset ${b.dataset_id}`}</span> as {b.format.toUpperCase()}</>
                      ) : whole ? (
                        "record (all fields as JSON)"
                      ) : (
                        <>field {v.datasets.map((d) => <span key={d.position} className="mr-2 font-mono text-ink">{d.mapping[name]}</span>)}</>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {v.datasets.length > 0 ? (
            <div>
              <div className="mb-1 text-xs text-muted">Record sources (one prompt per record)</div>
              <ul className="space-y-1">
                {v.datasets.map((d) => (
                  <li key={d.position} className="flex items-center gap-2">
                    <FormatBadge format={d.format} />
                    <DatasetLink id={d.dataset_id} available={d.available} filename={d.filename} />
                    {d.row_count != null && <span className="tabular text-xs text-muted">{d.row_count.toLocaleString()} rows</span>}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-ink-2">No record sources: each run sends a single prompt per model.</p>
          )}
        </div>
      </Card>

      <Card title="Expected outputs" actions={<span className="text-xs text-muted">how replies are processed and compared</span>}>
        <div className="space-y-4 text-sm">
          <div>
            <div className="mb-1 text-xs text-muted">Expected values</div>
            {v.datasets.length === 0 && <p>{v.expected_text ? <span className="font-mono">{v.expected_text}</span> : <span className="text-muted">none</span>}</p>}
            <ul className="space-y-1.5">
              {v.datasets.map((d) => (
                <li key={d.position} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-mono text-xs text-ink-2">{d.filename}</span>
                  <span className="text-muted">←</span>
                  {d.expected_dataset_id ? (
                    <>
                      <FormatBadge format={d.expected_format} />
                      <DatasetLink id={d.expected_dataset_id} available={d.expected_available} filename={d.expected_filename ?? "?"} />
                      <span className="text-xs text-ink-2">
                        matched {d.input_key ? `on ${d.input_key} = ${d.expected_key}` : "by record order"} · {d.expected_column ? `field ${d.expected_column}` : "whole record as JSON"}
                      </span>
                    </>
                  ) : d.expected_column ? (
                    <span className="text-xs">
                      field <code>{d.expected_column}</code> of the input file
                    </span>
                  ) : (
                    <span className="text-xs text-muted">none</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Processing the reply</div>
            <div>{describeExtract(cfg.extract as Record<string, unknown> | undefined)}</div>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Comparison</div>
            <div>{method}</div>
            {Array.isArray(cfg.fields) && <div className="mt-0.5 font-mono text-xs">fields: {(cfg.fields as string[]).join(", ")}</div>}
            {typeof cfg.rubric === "string" && <div className="mt-0.5 text-xs">rubric: {cfg.rubric}</div>}
            {cfg.pass_threshold != null && <div className="mt-0.5 text-xs text-ink-2">pass threshold {String(cfg.pass_threshold)}</div>}
            {cfg.schema != null && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted">Output schema</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-2/60 p-2 font-mono text-xs">{JSON.stringify(cfg.schema, null, 2)}</pre>
              </details>
            )}
          </div>
        </div>
      </Card>

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
