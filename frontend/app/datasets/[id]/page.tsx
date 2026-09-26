"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { RunsTable } from "@/components/RunsTable";
import { Button, Card, Empty, ErrorNote } from "@/components/ui";
import { api, type DatasetDetail, type RunListItem } from "@/lib/api";
import { when } from "@/lib/format";

export default function DatasetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ds, setDs] = useState<DatasetDetail | null>(null);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dataset(id, 100).then(setDs, (e) => setError(e.message));
    api.runs({ dataset_id: Number(id), limit: 20 }).then((r) => setRuns(r.items));
  }, [id]);

  const remove = async () => {
    if (!ds || !window.confirm(`Delete ${ds.filename}? Past runs keep their inputs and results.`)) return;
    await api.deleteDataset(ds.id);
    router.replace("/datasets");
  };

  if (!ds) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3">
        <div>
          <Link href="/datasets" className="text-sm text-ink-2 hover:text-ink">
            ← Datasets
          </Link>
          <h1 className="mt-1 font-mono text-2xl font-semibold tracking-tight">{ds.filename}</h1>
          <p className="mt-1 text-sm text-ink-2">
            {ds.row_count.toLocaleString()} rows · {ds.columns.length} columns · {ds.format.toUpperCase()} · uploaded {when(ds.created_at)}
            {ds.created_by && ` by ${ds.created_by}`}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={remove}>
            Delete
          </Button>
          <Link href={`/profiles/new?dataset=${ds.id}`} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
            Use in a new profile →
          </Link>
        </div>
      </div>

      <Card title={`Rows${ds.row_count > ds.rows.length ? ` (first ${ds.rows.length})` : ""}`}>
        <div className="max-h-[28rem] overflow-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-left">
              <tr>
                <th className="px-2 py-1.5 font-medium text-muted">#</th>
                {ds.columns.map((c) => (
                  <th key={c} className="px-2 py-1.5 font-mono font-medium text-ink-2">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ds.rows.map((r) => (
                <tr key={r.idx} className="border-t border-line align-top">
                  <td className="tabular px-2 py-1 text-muted">{r.idx}</td>
                  {ds.columns.map((c) => (
                    <td key={c} className="max-w-sm px-2 py-1" title={r[c]}>
                      <div className="line-clamp-3">{r[c]}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Runs using this file">
        {runs === null ? <Empty>Loading…</Empty> : runs.length === 0 ? <Empty>Not used yet.</Empty> : <RunsTable runs={runs} compact />}
      </Card>
    </div>
  );
}
