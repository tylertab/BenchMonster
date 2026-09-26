"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AssistantChat } from "@/components/AssistantChat";
import { SqlConsole } from "@/components/SqlConsole";
import { compactInputClass, StatusBadge } from "@/components/ui";
import { api, type ChatMessage, type ProfileListItem, type Run } from "@/lib/api";
import { type BMQueryScope, presetQueries, scopeKey } from "@/lib/bmquery";

/** SQL console + AI analyst for one scope. Remounted (via key) when the scope changes. */
function Workspace({ scope }: { scope: BMQueryScope }) {
  const [sql, setSql] = useState(() => presetQueries(scope)[0].sql);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <SqlConsole presets={presetQueries(scope)} sql={sql} onSqlChange={setSql} />
      <AssistantChat scope={scope} onOpenSql={setSql} messages={messages} setMessages={setMessages} />
    </div>
  );
}

function BMQuery() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const runId = Number(params.get("run")) || null;
  const profileId = Number(params.get("profile")) || null;
  const scope: BMQueryScope = runId ? { kind: "run", runId } : profileId ? { kind: "profile", profileId } : { kind: "org" };

  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    api.profiles().then(setProfiles);
  }, []);
  useEffect(() => {
    if (runId) api.run(runId).then(setRun);
  }, [runId]);

  const profile = profiles.find((p) => p.id === (runId ? run?.profile_id : profileId));
  const pickerValue = runId ? `run` : profileId ? String(profileId) : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">BMQuery</h1>
          <p className="mt-1 text-sm text-ink-2">
            {scope.kind === "run" ? (
              <>
                Analyzing{" "}
                <Link href={`/runs/${runId}`} className="text-accent hover:underline">
                  Run ID {runId}
                </Link>
                {run?.name && ` · ${run.name}`}
                {run?.profile_name && (
                  <>
                    {" "}
                    of{" "}
                    <Link href={`/profiles/${run.profile_id}?version=${run.profile_version}`} className="text-accent hover:underline">
                      {run.profile_name} v{run.profile_version}
                    </Link>
                  </>
                )}{" "}
                {run && <StatusBadge status={run.status} />}
              </>
            ) : scope.kind === "profile" ? (
              <>
                Analyzing every version and run of{" "}
                <Link href={`/profiles/${profileId}`} className="text-accent hover:underline">
                  {profile?.name ?? "this benchmark"}
                </Link>
                .
              </>
            ) : (
              "Query and analyze all of your benchmark results with SQL or the AI analyst."
            )}
          </p>
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-ink-2">Scope</span>
          <select
            className={`${compactInputClass} max-w-64`}
            value={pickerValue}
            onChange={(e) => router.replace(e.target.value ? `${pathname}?profile=${e.target.value}` : pathname)}
            aria-label="BMQuery scope"
          >
            <option value="">All benchmarks</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {runId && <option value="run">Run ID {runId}</option>}
          </select>
        </label>
      </div>
      <Workspace key={scopeKey(scope)} scope={scope} />
    </div>
  );
}

export default function BMQueryPage() {
  return (
    <Suspense>
      <BMQuery />
    </Suspense>
  );
}
