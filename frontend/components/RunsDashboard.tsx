"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { RunsTable } from "@/components/RunsTable";
import { Button, Card, compactInputClass, Empty, ErrorNote, inputClass } from "@/components/ui";
import { api, type Dataset, type Model, type ProfileListItem, type RunListItem } from "@/lib/api";

const PAGE = 25;
const STATUSES = ["queued", "running", "completed", "failed"];

/**
 * Runs list with search and filters (kept in the URL). With `profile`, it's
 * scoped to that benchmark profile and offers a version filter + Create run.
 */
export function RunsDashboard({ profile }: { profile?: { id: number; name: string; current_version: number } }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Filters live in the URL so a filtered view can be shared or bookmarked.
  const scopedProfileId = profile?.id;
  const filters = useMemo(
    () => ({
      q: params.get("q") ?? "",
      status: params.get("status") ?? "",
      profile_id: scopedProfileId ? String(scopedProfileId) : (params.get("profile") ?? ""),
      version: params.get("version") ?? "",
      dataset_id: params.get("dataset") ?? "",
      model_id: params.get("model") ?? "",
      sort: (params.get("sort") as "newest" | "oldest") ?? "newest",
      page: Number(params.get("page") ?? 0),
    }),
    [params, scopedProfileId],
  );
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`);
  };

  const [search, setSearch] = useState(filters.q);
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => setFilter("q", search.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const [data, setData] = useState<{ total: number; items: RunListItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<{ profiles: ProfileListItem[]; datasets: Dataset[]; models: Model[] }>({ profiles: [], datasets: [], models: [] });

  useEffect(() => {
    Promise.all([api.profiles(), api.datasets(), api.models()]).then(([profiles, datasets, models]) => setOptions({ profiles, datasets, models }));
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .runs({
          q: filters.q || undefined,
          status: filters.status || undefined,
          profile_id: filters.profile_id ? Number(filters.profile_id) : undefined,
          version: filters.version ? Number(filters.version) : undefined,
          dataset_id: filters.dataset_id ? Number(filters.dataset_id) : undefined,
          model_id: filters.model_id ? Number(filters.model_id) : undefined,
          sort: filters.sort,
          limit: PAGE,
          offset: filters.page * PAGE,
        })
        .then(
          (d) => {
            if (!alive) return;
            setData(d);
            setError(null);
            // Keep live runs' progress fresh.
            if (d.items.some((r) => r.status === "queued" || r.status === "running")) timer = setTimeout(load, 3000);
          },
          (e) => alive && setError(e.message),
        );
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [filters]);

  const filtered = filters.q || filters.status || (!profile && filters.profile_id) || filters.version || filters.dataset_id || filters.model_id;
  const selectedProfile = profile ?? options.profiles.find((p) => String(p.id) === filters.profile_id);
  const pages = data ? Math.ceil(data.total / PAGE) : 0;

  return (
    <div className="space-y-6">

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} max-w-sm`}
          placeholder="Search profiles, prompts, models, run ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search runs"
        />
        <select className={compactInputClass} value={filters.status} onChange={(e) => setFilter("status", e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        {!profile && (
          <select
            className={`${compactInputClass} max-w-48`}
            value={filters.profile_id}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              if (e.target.value) next.set("profile", e.target.value);
              else next.delete("profile");
              next.delete("version");
              next.delete("page");
              router.replace(`${pathname}${next.size ? `?${next}` : ""}`);
            }}
            aria-label="Benchmark profile"
          >
            <option value="">Any profile</option>
            {options.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {selectedProfile && (
          <select className={compactInputClass} value={filters.version} onChange={(e) => setFilter("version", e.target.value)} aria-label="Version">
            <option value="">All versions</option>
            {Array.from({ length: selectedProfile.current_version }, (_, i) => selectedProfile.current_version - i).map((v) => (
              <option key={v} value={v}>
                v{v}
                {v === selectedProfile.current_version ? " (current)" : ""}
              </option>
            ))}
          </select>
        )}
        <select className={`${compactInputClass} max-w-48`} value={filters.dataset_id} onChange={(e) => setFilter("dataset", e.target.value)} aria-label="Input file">
          <option value="">Any input file</option>
          {options.datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.filename}
            </option>
          ))}
        </select>
        <select className={`${compactInputClass} max-w-48`} value={filters.model_id} onChange={(e) => setFilter("model", e.target.value)} aria-label="Model">
          <option value="">Any model</option>
          {options.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}
            </option>
          ))}
        </select>
        <select className={compactInputClass} value={filters.sort} onChange={(e) => setFilter("sort", e.target.value === "newest" ? "" : e.target.value)} aria-label="Sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch("");
              router.replace(pathname);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <ErrorNote error={error} />
      <Card>
        {data === null ? (
          <Empty>Loading…</Empty>
        ) : data.items.length === 0 ? (
          <Empty>
            {filtered ? (
              "No runs match these filters."
            ) : profile ? (
              "No runs of this profile yet. Use Create run to run the current version."
            ) : (
              <>
                No runs yet.{" "}
                <Link href="/" className="text-accent underline">
                  Open a benchmark profile
                </Link>{" "}
                and create a run.
              </>
            )}
          </Empty>
        ) : (
          <>
            <RunsTable runs={data.items} />
            <div className="mt-3 flex items-center gap-2 text-xs text-ink-2">
              <span>
                {data.total} run{data.total === 1 ? "" : "s"}
              </span>
              {pages > 1 && (
                <span className="ml-auto flex items-center gap-2">
                  <Button variant="ghost" disabled={filters.page === 0} onClick={() => setFilter("page", String(filters.page - 1))}>
                    ←
                  </Button>
                  page {filters.page + 1} / {pages}
                  <Button variant="ghost" disabled={filters.page >= pages - 1} onClick={() => setFilter("page", String(filters.page + 1))}>
                    →
                  </Button>
                </span>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
