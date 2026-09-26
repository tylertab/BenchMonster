"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AssistantChat } from "@/components/AssistantChat";
import { presetQueries, SqlConsole } from "@/components/SqlConsole";
import { StatusBadge } from "@/components/ui";
import { api, type ChatMessage, type Run } from "@/lib/api";

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);
  const [run, setRun] = useState<Run | null>(null);
  const [sql, setSql] = useState(() => presetQueries(runId)[0].sql);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    api.run(id).then(setRun);
  }, [id]);

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/runs/${id}`} className="text-sm text-ink-2 hover:text-ink">
          ← Run #{id} dashboard
        </Link>
        <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold tracking-tight">
          Review: {run?.benchmark_name ?? "…"} {run && <StatusBadge status={run.status} />}
        </h1>
        <p className="mt-1 text-sm text-ink-2">Query the raw results with SQL, or ask the AI analyst.</p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <SqlConsole runId={runId} sql={sql} onSqlChange={setSql} />
        <AssistantChat runId={runId} onOpenSql={setSql} messages={messages} setMessages={setMessages} />
      </div>
    </div>
  );
}
