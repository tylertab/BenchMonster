"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RunListItem } from "@/lib/api";
import { pct, usd, when } from "@/lib/format";
import { StatusBadge } from "./ui";

/** Runs with their profile version, headline metrics, and who ran them when (prompt/models live on the profile). */
export function RunsTable({ runs }: { runs: RunListItem[] }) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="pb-2 font-medium">Run ID</th>
            <th className="pb-2 font-medium">Profile</th>
            <th className="whitespace-nowrap pb-2 pl-3 text-right font-medium">Best acc.</th>
            <th className="pb-2 pl-3 text-right font-medium">Cost</th>
            <th className="pb-2 pl-4 font-medium">Run by</th>
            <th className="pb-2 pl-4 text-right font-medium">Run date</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const total = r.total_inputs * r.models.length;
            const live = r.status === "queued" || r.status === "running";
            return (
              <tr
                key={r.id}
                onClick={() => router.push(`/runs/${r.id}`)}
                className="cursor-pointer border-t border-line align-top hover:bg-surface-2/60"
              >
                <td className="py-2.5 pr-3">
                  <Link href={`/runs/${r.id}`} className="tabular font-mono font-semibold hover:text-accent" onClick={(e) => e.stopPropagation()}>
                    {r.id}
                  </Link>
                  {r.name && <div className="max-w-[12rem] truncate text-sm">{r.name}</div>}
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    {live && (
                      <span className="tabular text-xs text-ink-2">
                        {r.done}/{total}
                      </span>
                    )}
                  </div>
                </td>
                <td className="max-w-[12rem] py-2.5 pr-3">
                  {r.profile_id ? (
                    <Link
                      href={`/profiles/${r.profile_id}?version=${r.profile_version}`}
                      onClick={(e) => e.stopPropagation()}
                      className="hover:text-accent"
                    >
                      <span className="font-medium">{r.profile_name}</span>{" "}
                      <span className="rounded bg-accent/10 px-1 text-xs text-accent">v{r.profile_version}</span>
                    </Link>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </td>
                <td className="tabular whitespace-nowrap py-2.5 pl-3 text-right">{pct(r.best_accuracy, 1)}</td>
                <td className="tabular whitespace-nowrap py-2.5 pl-3 text-right">{usd(r.total_cost_usd)}</td>
                <td className="whitespace-nowrap py-2.5 pl-4 text-xs text-ink-2">{r.created_by ?? "–"}</td>
                <td className="whitespace-nowrap py-2.5 pl-4 text-right text-xs text-ink-2">{when(r.started_at ?? r.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
