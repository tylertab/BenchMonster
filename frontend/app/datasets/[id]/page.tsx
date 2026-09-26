"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormatBadge } from "@/components/InputSetEditor";
import { RunsTable } from "@/components/RunsTable";
import { SchemaEditor } from "@/components/SchemaEditor";
import { Button, Card, Empty, ErrorNote, Field, inputClass } from "@/components/ui";
import { api, type DatasetDetail, type RunListItem } from "@/lib/api";
import { when } from "@/lib/format";

export default function DatasetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ds, setDs] = useState<DatasetDetail | null>(null);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.dataset(id, 100).then(
      (d) => {
        setDs(d);
        setName(d.name);
        setDescription(d.description ?? "");
      },
      (e) => setError(e.message),
    );
    api.runs({ dataset_id: Number(id), limit: 20 }).then((r) => setRuns(r.items));
  }, [id]);

  const remove = async () => {
    if (!ds || !window.confirm(`Delete ${ds.filename}? Past runs keep their inputs and results.`)) return;
    await api.deleteDataset(ds.id);
    router.replace("/datasets");
  };

  const saveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ds) return;
    setError(null);
    try {
      const d = await api.updateDataset(ds.id, { name, description: description || null });
      setDs({ ...ds, name: d.name, description: d.description });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!ds) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3">
        <div>
          <Link href="/datasets" className="text-sm text-ink-2 hover:text-ink">
            ← Datasets
          </Link>
          <h1 className="mt-1 flex items-center gap-2 font-mono text-2xl font-semibold tracking-tight">
            <FormatBadge format={ds.format} />
            {ds.filename}
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            {ds.row_count.toLocaleString()} records · {ds.columns.length} fields · uploaded {when(ds.created_at)}
            {ds.created_by && ` by ${ds.created_by}`} · used as input in {ds.run_count} run{ds.run_count === 1 ? "" : "s"}, as expected outputs in{" "}
            {ds.expected_run_count}
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
      <ErrorNote error={error} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Card title="Details">
          <form onSubmit={saveDetails} className="space-y-3">
            <Field label="Name">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Description" hint="What the rows are and how they should be used (input set, expected outputs…)">
              <textarea rows={4} className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-muted">File type</dt>
                <dd className="font-medium uppercase">{ds.format}</dd>
              </div>
              <div>
                <dt className="text-muted">File name</dt>
                <dd className="truncate font-mono">{ds.filename}</dd>
              </div>
            </dl>
            <Button type="submit" disabled={!name.trim() || (name === ds.name && description === (ds.description ?? ""))}>
              {saved ? "Saved ✓" : "Save details"}
            </Button>
          </form>
        </Card>

        <Card title="Row schema" actions={<span className="text-xs text-muted">JSON Schema for one row</span>}>
          {ds.schema && (
            <SchemaEditor
              datasetId={ds.id}
              columns={ds.columns}
              initial={ds.schema}
              onSaved={async (schema) => {
                const d = await api.updateDataset(ds.id, { name: ds.name, description: ds.description, schema });
                setDs({ ...ds, schema: d.schema });
              }}
            />
          )}
        </Card>
      </div>

      <Card title={`Rows${ds.row_count > ds.rows.length ? ` (first ${ds.rows.length})` : ""}`}>
        <div className="max-h-[28rem] overflow-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-left">
              <tr>
                <th className="px-2 py-1.5 font-medium text-muted">#</th>
                {ds.columns.map((c) => (
                  <th key={c} className="px-2 py-1.5 font-mono font-medium text-ink-2" title={ds.schema?.properties?.[c]?.description}>
                    {c}
                    {ds.schema?.properties?.[c]?.type && <span className="ml-1 font-normal text-muted">{ds.schema.properties[c].type}</span>}
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
