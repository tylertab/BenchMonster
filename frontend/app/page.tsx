"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { RunsTable } from "@/components/RunsTable";
import { Button, Card, compactInputClass, Empty, ErrorNote, inputClass } from "@/components/ui";
import { api, type Dataset, type Model, type Prompt, type RunListItem } from "@/lib/api";

const PAGE = 25;
const STATUSES = ["queued", "running", "completed", "failed"];

function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Filters live in the URL so a filtered view can be shared or bookmarked.
  const filters = useMemo(
    () => ({
      q: params.get("q") ?? "",
      status: params.get("status") ?? "",
      prompt_id: params.get("prompt") ?? "",
      dataset_id: params.get("dataset") ?? "",
      model_id: params.get("model") ?? "",
      sort: (params.get("sort") as "newest" | "oldest") ?? "newest",
      page: Number(params.get("page") ?? 0),
    }),
    [params],
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
  const [options, setOptions] = useState<{ prompts: Prompt[]; datasets: Dataset[]; models: Model[] }>({ prompts: [], datasets: [], models: [] });

  useEffect(() => {
    Promise.all([api.prompts(), api.datasets(), api.models()]).then(([prompts, datasets, models]) => setOptions({ prompts, datasets, models }));
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .runs({
          q: filters.q || undefined,
          status: filters.status || undefined,
          prompt_id: filters.prompt_id ? Number(filters.prompt_id) : undefined,
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

  const filtered = filters.q || filters.status || filters.prompt_id || filters.dataset_id || filters.model_id;
  const pages = data ? Math.ceil(data.total / PAGE) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="mt-1 text-sm text-ink-2">Every run of a prompt over your input files, with its predictions file and metrics.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} max-w-sm`}
          placeholder="Search prompts, templates, files, models, #id…"
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
        <select className={`${compactInputClass} max-w-48`} value={filters.prompt_id} onChange={(e) => setFilter("prompt", e.target.value)} aria-label="Prompt">
          <option value="">Any prompt</option>
          {options.prompts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
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
            ) : (
              <>
                No runs yet. Create a{" "}
                <Link href="/prompts/new" className="text-accent underline">
                  prompt
                </Link>
                , upload a{" "}
                <Link href="/datasets" className="text-accent underline">
                  dataset
                </Link>
                , then{" "}
                <Link href="/runs/new" className="text-accent underline">
                  start a run
                </Link>
                .
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

export default function Home() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}
