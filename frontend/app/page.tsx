"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Empty, ErrorNote } from "@/components/ui";
import { api, type BenchmarkListItem } from "@/lib/api";
import { when } from "@/lib/format";

const METHOD_LABEL: Record<string, string> = {
  exact: "Exact match",
  contains: "Contains",
  regex: "Regex",
  numeric: "Numeric",
  json_schema: "JSON schema",
  llm_judge: "LLM judge",
};

export default function Home() {
  const [benchmarks, setBenchmarks] = useState<BenchmarkListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.benchmarks().then(setBenchmarks, (e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Benchmarks</h1>
        <p className="mt-1 text-sm text-ink-2">
          Compare hosted and custom LLMs on your own data: accuracy, speed, and cost.
        </p>
      </div>
      <ErrorNote error={error} />
      <Card>
        {benchmarks === null ? (
          <Empty>Loading…</Empty>
        ) : benchmarks.length === 0 ? (
          <Empty>
            No benchmarks yet.{" "}
            <Link href="/benchmarks/new" className="text-accent underline">
              Create your first one
            </Link>
            .
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Scoring</th>
                <th className="pb-2 text-right font-medium">Cases</th>
                <th className="pb-2 text-right font-medium">Runs</th>
                <th className="pb-2 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {benchmarks.map((b) => (
                <tr key={b.id} className="border-t border-line">
                  <td className="py-2.5">
                    <Link href={`/benchmarks/${b.id}`} className="font-medium hover:text-accent">
                      {b.name}
                    </Link>
                    {b.description && <div className="text-xs text-muted">{b.description}</div>}
                  </td>
                  <td className="py-2.5 text-ink-2">{METHOD_LABEL[b.scoring_method] ?? b.scoring_method}</td>
                  <td className="py-2.5 text-right">{b.case_count}</td>
                  <td className="py-2.5 text-right">{b.run_count}</td>
                  <td className="py-2.5 text-right text-ink-2">{when(b.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
