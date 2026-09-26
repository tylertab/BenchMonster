"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FormatBadge } from "@/components/InputSetEditor";
import { Card, Empty, ErrorNote } from "@/components/ui";
import { api, type Dataset } from "@/lib/api";
import { when } from "@/lib/format";

const SAMPLE = { url: "/samples/math-word-problems.csv", name: "math-word-problems.csv" };

export default function DatasetsPage() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = () => api.datasets().then(setDatasets, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const upload = async (files: FileList | File[]) => {
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) await api.uploadDataset(f);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const uploadSample = async () => {
    const blob = await (await fetch(SAMPLE.url)).blob();
    upload([new File([blob], SAMPLE.name)]);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Datasets</h1>
        <p className="mt-1 text-sm text-ink-2">Input sets and expected-output sets for your benchmark profiles. Each file keeps its type, a description, and a row schema.</p>
      </div>
      <label
        className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-line bg-surface px-4 py-8 text-center text-sm hover:bg-surface-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
      >
        <input type="file" multiple accept=".csv,.jsonl,.ndjson,.json" className="sr-only" onChange={(e) => e.target.files?.length && upload(e.target.files)} />
        <span className="font-medium">{uploading ? "Uploading…" : "Drop CSV, JSONL, or JSON files here, or click to choose"}</span>
        <span className="text-xs text-muted">Up to 5,000 rows each. Each row becomes one input.</span>
      </label>
      <button type="button" onClick={uploadSample} className="text-xs text-accent hover:underline">
        or add the sample math dataset
      </button>
      <ErrorNote error={error} />
      <Card>
        {datasets === null ? (
          <Empty>Loading…</Empty>
        ) : datasets.length === 0 ? (
          <Empty>No datasets yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">File</th>
                <th className="pb-2 font-medium">Columns</th>
                <th className="pb-2 text-right font-medium">Rows</th>
                <th className="pb-2 text-right font-medium">Used as input</th>
                <th className="pb-2 text-right font-medium">As expected</th>
                <th className="pb-2 text-right font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className="border-t border-line align-top">
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      <FormatBadge format={d.format} />
                      <Link href={`/datasets/${d.id}`} className="font-mono font-medium hover:text-accent">
                        {d.filename}
                      </Link>
                    </div>
                    {d.name !== d.filename.replace(/\.[^.]+$/, "") && <div className="text-xs text-ink-2">{d.name}</div>}
                    {d.description && <div className="line-clamp-2 max-w-md text-xs text-muted">{d.description}</div>}
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {d.columns.map((c) => (
                        <code key={c} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs" title={d.schema?.properties?.[c]?.description}>
                          {c}
                          {d.schema?.properties?.[c]?.type && <span className="ml-1 text-muted">{d.schema.properties[c].type}</span>}
                        </code>
                      ))}
                    </div>
                  </td>
                  <td className="tabular py-2.5 text-right">{d.row_count.toLocaleString()}</td>
                  <td className="tabular py-2.5 text-right">{d.run_count}</td>
                  <td className="tabular py-2.5 text-right">{d.expected_run_count}</td>
                  <td className="py-2.5 text-right text-xs text-ink-2">
                    {when(d.created_at)}
                    {d.created_by && <div className="text-muted">{d.created_by}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
