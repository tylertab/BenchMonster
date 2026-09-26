"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { METHODS } from "@/components/ScoringConfig";
import { Card, Empty, ErrorNote } from "@/components/ui";
import { api, type ProfileListItem } from "@/lib/api";
import { pct, when } from "@/lib/format";

export default function ProfilesHome() {
  const [profiles, setProfiles] = useState<ProfileListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profiles().then(setProfiles, (e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Benchmark profiles</h1>
          <p className="mt-1 text-sm text-ink-2">A profile is a prompt + input sets + output expectations + models. Edit it to create a new version; runs record which version they used.</p>
        </div>
        <Link href="/runs" className="ml-auto text-sm text-accent hover:underline">
          All runs →
        </Link>
        <Link href="/profiles/new" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          New profile
        </Link>
      </div>
      <ErrorNote error={error} />
      {profiles === null ? (
        <Empty>Loading…</Empty>
      ) : profiles.length === 0 ? (
        <Card>
          <Empty>
            No benchmark profiles yet.{" "}
            <Link href="/profiles/new" className="text-accent underline">
              Create your first one
            </Link>
            .
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {profiles.map((p) => (
            <Link key={p.id} href={`/profiles/${p.id}`} className="flex flex-col rounded-lg border border-line bg-surface p-4 hover:border-accent/50">
              <div className="flex items-start gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="ml-auto shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">v{p.current_version}</span>
              </div>
              {p.description && <p className="mt-1 line-clamp-2 text-sm text-ink-2">{p.description}</p>}
              <dl className="mt-3 space-y-1 text-xs text-ink-2">
                <div>
                  <dt className="inline text-muted">Prompt · </dt>
                  <dd className="inline">{p.prompt_name}</dd>
                </div>
                <div className="truncate">
                  <dt className="inline text-muted">Inputs · </dt>
                  <dd className="inline font-mono">{p.input_files.join(", ")}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">Scoring · </dt>
                  <dd className="inline">{METHODS.find((m) => m.value === p.scoring_method)?.label ?? p.scoring_method}</dd>
                  <span className="text-muted">
                    {" "}
                    · {p.model_count} model{p.model_count === 1 ? "" : "s"}
                  </span>
                </div>
              </dl>
              <div className="mt-auto flex items-center gap-3 border-t border-line pt-3 text-xs">
                <span className="tabular">
                  {p.run_count} run{p.run_count === 1 ? "" : "s"}
                </span>
                {p.current_best_accuracy != null && <span className="tabular text-ink-2">best on v{p.current_version}: {pct(p.current_best_accuracy, 1)}</span>}
                <span className="ml-auto text-muted">{p.last_run_at ? `last run ${when(p.last_run_at)}` : "never run"}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
