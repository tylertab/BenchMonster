"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Card, compactInputClass, Empty, ErrorNote, inputClass } from "@/components/ui";
import { api, type ProfileListItem } from "@/lib/api";
import { when } from "@/lib/format";

type Sort = "updated" | "name" | "runs";

export default function ProfilesHome() {
  const router = useRouter();
  const [profiles, setProfiles] = useState<ProfileListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("updated");

  useEffect(() => {
    api.profiles().then(setProfiles, (e) => setError(e.message));
  }, []);

  const term = q.trim().toLowerCase();
  const shown = (profiles ?? [])
    .filter((p) => !term || [p.name, p.description].some((s) => s?.toLowerCase().includes(term)))
    .sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "runs" ? b.run_count - a.run_count : b.updated_at.localeCompare(a.updated_at),
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Benchmark profiles</h1>
          <p className="mt-1 text-sm text-ink-2">A profile is a prompt + inputs + expected outputs + models. Edit it to create a new version; runs record which version they used.</p>
        </div>
        <Link href="/runs" className="ml-auto text-sm text-accent hover:underline">
          All runs →
        </Link>
        <Link href="/bmquery" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
          Query with BMQuery
        </Link>
        <Link href="/profiles/new" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          New profile
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} max-w-sm`} placeholder="Search profiles…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search profiles" />
        <select className={compactInputClass} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort profiles">
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
          <option value="runs">Most runs</option>
        </select>
      </div>

      <ErrorNote error={error} />
      <Card>
        {profiles === null ? (
          <Empty>Loading…</Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {profiles.length === 0 ? (
              <>
                No benchmark profiles yet.{" "}
                <Link href="/profiles/new" className="text-accent underline">
                  Create your first one
                </Link>
                .
              </>
            ) : (
              "No profiles match."
            )}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Profile</th>
                  <th className="pb-2 font-medium">Version</th>
                  <th className="pb-2 text-right font-medium">Runs</th>
                  <th className="pb-2 pl-4 text-right font-medium">Last run</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} onClick={() => router.push(`/profiles/${p.id}`)} className="cursor-pointer border-t border-line align-top hover:bg-surface-2/60">
                    <td className="max-w-xs py-2.5 pr-3">
                      <Link href={`/profiles/${p.id}`} className="font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>
                        {p.name}
                      </Link>
                      {p.description && <div className="line-clamp-2 text-xs text-muted">{p.description}</div>}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">v{p.current_version}</span>
                    </td>
                    <td className="tabular py-2.5 text-right">{p.run_count}</td>
                    <td className="whitespace-nowrap py-2.5 pl-4 text-right text-xs text-ink-2">{p.last_run_at ? when(p.last_run_at) : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 text-xs text-ink-2">
              {shown.length} profile{shown.length === 1 ? "" : "s"}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
