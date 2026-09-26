"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { HBarChart, ProgressBar, ScatterChart, StatTile } from "@/components/charts";
import { ResultsExplorer } from "@/components/ResultsExplorer";
import { RunMetadata } from "@/components/RunMetadata";
import { Card, Empty, ErrorNote, StatusBadge } from "@/components/ui";
import { api, type ModelSummary, type Run } from "@/lib/api";
import { ms, num, pct, usd, when } from "@/lib/format";

const POLL_MS = 2000;

function best(rows: ModelSummary[], key: (r: ModelSummary) => number | null, dir: "max" | "min") {
  const valid = rows.filter((r) => key(r) != null);
  if (!valid.length) return null;
  const top = valid.reduce((a, b) => ((dir === "max" ? key(b)! > key(a)! : key(b)! < key(a)!) ? b : a));
  const ties = valid.filter((r) => key(r) === key(top)).length;
  return { ...top, model: ties > 1 ? `${ties} models tied` : top.model };
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.run(id);
        if (!alive) return;
        setRun(r);
        if (r.status === "queued" || r.status === "running") timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  if (!run) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  const s = run.summary;
  const live = run.status === "queued" || run.status === "running";
  const done = run.models.reduce((a, m) => a + m.done, 0);
  const total = run.total_inputs * run.models.length;
  const n = (v: number | null) => (v == null ? null : Number(v));

  const mostAccurate = best(s, (r) => n(r.accuracy), "max");
  const fastest = best(s, (r) => n(r.p50_latency_ms), "min");
  const cheapest = best(s, (r) => n(r.total_cost_usd), "min");
  const bestValue = best(s, (r) => n(r.cost_per_pass_usd), "min");

  const bars = (key: keyof ModelSummary, fmt: (v: number) => string) =>
    s.filter((r) => r[key] != null).map((r) => ({ label: r.model, value: Number(r[key]), display: fmt(Number(r[key])) }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Link href="/" className="text-sm text-ink-2 hover:text-ink">
            ← Runs
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold tracking-tight">
            Run ID {run.id}
            {run.name && <span className="font-normal text-ink-2">{run.name}</span>}
            <StatusBadge status={run.status} />
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            {run.models.length} model{run.models.length === 1 ? "" : "s"} × {run.total_inputs} input{run.total_inputs === 1 ? "" : "s"} · started {when(run.started_at ?? run.created_at)}
            {run.finished_at && ` · finished ${when(run.finished_at)}`}
            {run.created_by_name && ` · by ${run.created_by_name}`}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link
            href={`/runs/new?from=${run.id}`}
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
            title="Start a new run from this run's prompt, input files, scoring, and models"
          >
            ⧉ Clone & edit
          </Link>
          <Link href={`/runs/${run.id}/review`} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90">
            Review with SQL & AI →
          </Link>
        </div>
      </div>

      <ErrorNote error={run.error} />

      <RunMetadata run={run} />

      {live && (
        <Card title={`Running… ${done} / ${total} calls`}>
          <div className="space-y-3">
            {run.models.map((m) => (
              <div key={m.id} className="grid grid-cols-[200px_1fr_80px] items-center gap-3 text-sm">
                <span className="truncate">{m.display_name}</span>
                <ProgressBar value={m.done} max={run.total_inputs} />
                <span className="tabular text-right text-ink-2">
                  {m.done}/{run.total_inputs}
                  {m.errors > 0 && <span className="text-critical"> · {m.errors}✕</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {s.length > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Most accurate" value={pct(mostAccurate?.accuracy, 1)} sub={mostAccurate?.model} />
            <StatTile label="Fastest (median latency)" value={ms(fastest?.p50_latency_ms)} sub={fastest?.model} />
            <StatTile label="Cheapest run" value={usd(cheapest?.total_cost_usd)} sub={cheapest?.model} />
            <StatTile label="Best value (cost per pass)" value={usd(bestValue?.cost_per_pass_usd)} sub={bestValue?.model} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Accuracy" actions={<span className="text-xs text-muted">mean score · higher is better</span>}>
              <HBarChart data={bars("accuracy", (v) => pct(v, 1))} max={1} better="higher" />
            </Card>
            <Card title="Median latency" actions={<span className="text-xs text-muted">p50 · lower is better</span>}>
              <HBarChart data={bars("p50_latency_ms", ms)} better="lower" />
            </Card>
            <Card title="Total cost" actions={<span className="text-xs text-muted">USD for all cases · lower is better</span>}>
              <HBarChart data={bars("total_cost_usd", usd)} better="lower" />
            </Card>
            <Card title="Accuracy vs. cost" actions={<span className="text-xs text-muted">top-left is best</span>}>
              <ScatterChart
                data={s
                  .filter((r) => r.accuracy != null && r.total_cost_usd != null)
                  .map((r) => ({
                    label: r.model,
                    x: Number(r.total_cost_usd),
                    y: Number(r.accuracy),
                    xDisplay: usd(r.total_cost_usd),
                    yDisplay: pct(r.accuracy, 1),
                  }))}
                xLabel="Total cost"
                yLabel="Accuracy"
                xFormat={usd}
              />
            </Card>
          </div>

          <Card title="All metrics">
            <div className="overflow-x-auto">
              <table className="tabular w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    {["Model", "Accuracy", "Pass rate", "p50", "p95", "TTFT", "Tok/s", "Tokens in", "Tokens out", "Reasoning", "Cost", "$/pass", "Errors"].map((h, i) => (
                      <th key={h} className={`pb-2 font-medium ${i ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.map((r) => (
                    <tr key={r.model_id} className="border-t border-line">
                      <td className="py-2 font-medium">{r.model}</td>
                      <td className="py-2 text-right">{pct(r.accuracy, 1)}</td>
                      <td className="py-2 text-right">{pct(r.pass_rate, 1)}</td>
                      <td className="py-2 text-right">{ms(r.p50_latency_ms)}</td>
                      <td className="py-2 text-right">{ms(r.p95_latency_ms)}</td>
                      <td className="py-2 text-right">{ms(r.avg_ttft_ms)}</td>
                      <td className="py-2 text-right">{num(r.avg_tokens_per_sec)}</td>
                      <td className="py-2 text-right">{num(r.tokens_in)}</td>
                      <td className="py-2 text-right">{num(r.tokens_out)}</td>
                      <td className="py-2 text-right">{num(r.reasoning_tokens)}</td>
                      <td className="py-2 text-right">{usd(r.total_cost_usd)}</td>
                      <td className="py-2 text-right">{usd(r.cost_per_pass_usd)}</td>
                      <td className={`py-2 text-right ${r.errors ? "text-critical" : ""}`}>{r.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <ResultsExplorer runId={run.id} models={run.models} refreshKey={done} />
    </div>
  );
}
