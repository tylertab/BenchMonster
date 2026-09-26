"use client";

import { Fragment, useEffect, useState } from "react";
import { api, type Result, type Run } from "@/lib/api";
import { ms, num, usd } from "@/lib/format";
import { Card, compactInputClass, Empty, PassBadge } from "./ui";

export function ResultsExplorer({ runId, models, refreshKey }: { runId: number; models: Run["models"]; refreshKey: number }) {
  const [modelId, setModelId] = useState<number | undefined>();
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [rows, setRows] = useState<Result[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api.results(runId, { modelId, onlyFailed }).then(setRows);
  }, [runId, modelId, onlyFailed, refreshKey]);

  return (
    <Card
      title="Per-input results"
      actions={
        <>
          <select className={compactInputClass} value={modelId ?? ""} onChange={(e) => setModelId(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
            <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
            Failures only
          </label>
        </>
      }
    >
      {rows === null ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>{onlyFailed ? "No failures. 🎉" : "No results yet."}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Input</th>
                <th className="pb-2 font-medium">Model</th>
                <th className="pb-2 font-medium">Output</th>
                <th className="pb-2 font-medium">Result</th>
                <th className="pb-2 text-right font-medium">Latency</th>
                <th className="pb-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer border-t border-line hover:bg-surface-2" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="whitespace-nowrap py-2 pr-2 font-mono text-xs text-muted">
                      {r.input_file}:{r.row_idx}
                    </td>
                    <td className="py-2 whitespace-nowrap">{r.model}</td>
                    <td className="max-w-md truncate py-2 text-ink-2">{r.error && !r.output ? r.error : r.output}</td>
                    <td className="py-2 whitespace-nowrap">
                      <PassBadge passed={r.passed} error={r.error} />
                      {r.score != null && r.score > 0 && r.score < 1 && <span className="ml-1 text-xs text-muted">{num(r.score, 2)}</span>}
                    </td>
                    <td className="py-2 text-right">{ms(r.latency_ms)}</td>
                    <td className="py-2 text-right">{usd(r.cost_usd)}</td>
                  </tr>
                  {open === r.id && (
                    <tr className="bg-surface-2/50">
                      <td colSpan={6} className="px-3 py-3">
                        <dl className="grid gap-3 text-sm md:grid-cols-3">
                          <div>
                            <dt className="text-xs text-muted">Variables</dt>
                            <dd className="space-y-1">
                              {Object.entries(r.variables).map(([k, v]) => (
                                <div key={k}>
                                  <code className="text-xs text-accent">{`{{${k}}}`}</code>{" "}
                                  <span className="whitespace-pre-wrap">{v}</span>
                                </div>
                              ))}
                            </dd>
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs text-muted">Rendered prompt</summary>
                              <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{r.prompt}</pre>
                            </details>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Expected</dt>
                            <dd className="whitespace-pre-wrap">{r.expected ?? "–"}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted">Output</dt>
                            <dd className="whitespace-pre-wrap">{r.output || "–"}</dd>
                            {r.processed_output != null && r.processed_output !== (r.output ?? "").trim() && (
                              <>
                                <dt className="mt-2 text-xs text-muted">Compared value (after processing)</dt>
                                <dd className="whitespace-pre-wrap font-mono text-xs">{r.processed_output}</dd>
                              </>
                            )}
                          </div>
                          {(r.judge_rationale || r.error) && (
                            <div className="md:col-span-3">
                              <dt className="text-xs text-muted">{r.error ? "Error" : "Scoring note"}</dt>
                              <dd className={r.error ? "text-critical" : ""}>{r.error ?? r.judge_rationale}</dd>
                            </div>
                          )}
                          <div className="text-xs text-ink-2 md:col-span-3">
                            TTFT {ms(r.ttft_ms)} · {num(r.tokens_in)} in / {num(r.tokens_out)} out
                            {r.reasoning_tokens ? ` (${num(r.reasoning_tokens)} reasoning)` : ""}
                          </div>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
