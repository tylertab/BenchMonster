"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DEFAULT_PARAMS, ModelPicker, type RunParams } from "@/components/ModelPicker";
import { METHODS } from "@/components/ScoringConfig";
import { Button, Card, Empty, ErrorNote, StatusBadge } from "@/components/ui";
import { api, type Benchmark } from "@/lib/api";
import { when } from "@/lib/format";

export default function BenchmarkPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [bench, setBench] = useState<Benchmark | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelIds, setModelIds] = useState<number[]>([]);
  const [params, setParams] = useState<RunParams>(DEFAULT_PARAMS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.benchmark(id).then(setBench, (e) => setError(e.message));
  }, [id]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.startRun(id, { model_ids: modelIds, ...params });
      router.push(`/runs/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (!bench) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;
  const method = METHODS.find((m) => m.value === bench.scoring_method);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-ink-2 hover:text-ink">
          ← Benchmarks
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{bench.name}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {bench.case_count} cases · scored by {method?.label ?? bench.scoring_method}
          {bench.description && ` · ${bench.description}`}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Runs">
          {bench.runs.length === 0 ? (
            <Empty>No runs yet.</Empty>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {bench.runs.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2">
                  <Link href={`/runs/${r.id}`} className="font-medium hover:text-accent">
                    Run #{r.id}
                  </Link>
                  <StatusBadge status={r.status} />
                  <span className="ml-auto text-ink-2">{when(r.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Setup">
          <dl className="space-y-2 text-sm">
            {bench.system_prompt && (
              <div>
                <dt className="text-xs text-muted">System prompt</dt>
                <dd className="whitespace-pre-wrap">{bench.system_prompt}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted">Prompt template</dt>
              <dd className="font-mono text-xs">{bench.prompt_template}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Scoring config</dt>
              <dd className="font-mono text-xs">{JSON.stringify(bench.scoring_config)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card title="Sample cases">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="w-10 pb-2 font-medium">#</th>
              <th className="pb-2 font-medium">Input</th>
              <th className="pb-2 font-medium">Expected</th>
            </tr>
          </thead>
          <tbody>
            {bench.sample_cases.map((c) => (
              <tr key={c.idx} className="border-t border-line align-top">
                <td className="tabular py-1.5 text-muted">{c.idx}</td>
                <td className="py-1.5 pr-4">{c.input}</td>
                <td className="py-1.5 text-ink-2">{c.expected ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Run again" actions={<Button onClick={run} disabled={busy || modelIds.length === 0}>{busy ? "Starting…" : "Start run"}</Button>}>
        <ErrorNote error={error} />
        <ModelPicker selected={modelIds} onChange={setModelIds} params={params} onParamsChange={setParams} />
      </Card>
    </div>
  );
}
