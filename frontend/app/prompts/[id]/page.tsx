"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PromptEditor } from "@/components/PromptEditor";
import { TemplateView, VariableChips } from "@/components/TemplateView";
import { Button, Card, Empty, ErrorNote } from "@/components/ui";
import { api, type PromptDetail, type PromptVersion } from "@/lib/api";
import { when } from "@/lib/format";

function PromptPageInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  const [old, setOld] = useState<PromptVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requested = Number(params.get("version")) || null;
  const viewing = prompt && requested && requested !== prompt.current_version ? requested : null;

  useEffect(() => {
    api.prompt(id).then(setPrompt, (e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (viewing) api.promptVersion(id, viewing).then(setOld, (e) => setError(e.message));
  }, [id, viewing]);

  const showVersion = (v: number | null) => router.replace(v ? `${pathname}?version=${v}` : pathname);
  const remove = async () => {
    if (!prompt || !window.confirm(`Delete prompt "${prompt.name}" and its ${prompt.versions.length} versions? Profiles and runs keep their own copy of the text.`)) return;
    await api.deletePrompt(prompt.id);
    router.replace("/prompts");
  };
  const restore = async (v: number) => {
    setError(null);
    try {
      setPrompt(await api.restorePromptVersion(prompt!.id, v));
      showVersion(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!prompt) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;
  const shownOld = viewing && old?.version === viewing ? old : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Link href="/prompts" className="text-sm text-ink-2 hover:text-ink">
            ← Prompts
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {prompt.name}
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-sm font-medium text-accent">v{prompt.current_version}</span>
          </h1>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={remove}>
            Delete
          </Button>
          <Link href={`/profiles/new?prompt=${prompt.id}`} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
            Use in a new profile →
          </Link>
        </div>
      </div>
      <ErrorNote error={error} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        {viewing ? (
          <Card
            title={`Version ${viewing}${shownOld?.note ? ` · ${shownOld.note}` : ""}`}
            actions={
              <>
                <Button variant="secondary" onClick={() => showVersion(null)}>
                  Back to current
                </Button>
                <Button onClick={() => restore(viewing)}>Restore as v{prompt.current_version + 1}</Button>
              </>
            }
          >
            {!shownOld ? (
              <Empty>Loading…</Empty>
            ) : (
              <div className="space-y-4 text-sm">
                <p className="text-xs text-muted">
                  Saved {when(shownOld.created_at)}
                  {shownOld.created_by ? ` by ${shownOld.created_by}` : ""}. Versions never change; restoring copies this text into a new version.
                </p>
                <div>
                  <div className="mb-1 text-xs text-muted">System prompt</div>
                  {shownOld.system_prompt ? <TemplateView template={shownOld.system_prompt} /> : <span className="text-muted">none</span>}
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted">Template</div>
                  <TemplateView template={shownOld.template} />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted">Variables:</span>
                  <VariableChips variables={shownOld.variables} />
                </div>
              </div>
            )}
          </Card>
        ) : (
          <Card title={`Edit (current: v${prompt.current_version})`}>
            <PromptEditor key={`${prompt.current_version}:${prompt.updated_at}`} prompt={prompt} onSaved={(p) => setPrompt(p as PromptDetail)} />
          </Card>
        )}

        <div className="space-y-6">
          <Card title="Versions">
            <ol className="space-y-1">
              {prompt.versions.map((v) => {
                const selected = v.version === (viewing ?? prompt.current_version);
                return (
                  <li key={v.version}>
                    <button
                      type="button"
                      onClick={() => showVersion(v.version === prompt.current_version ? null : v.version)}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${selected ? "bg-accent/10" : "hover:bg-surface-2"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`font-medium ${selected ? "text-accent" : ""}`}>v{v.version}</span>
                        {v.version === prompt.current_version && <span className="rounded bg-good/10 px-1.5 text-xs text-good-ink">current</span>}
                        {v.profile_version_count > 0 && (
                          <span className="ml-auto text-xs text-muted">
                            in {v.profile_version_count} profile version{v.profile_version_count === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      {v.note && <div className="truncate text-xs text-ink-2">{v.note}</div>}
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
                        {v.changed.map((c) => (
                          <span key={c} className="rounded bg-surface-2 px-1">
                            {c}
                          </span>
                        ))}
                        <span>
                          {when(v.created_at)}
                          {v.created_by ? ` · ${v.created_by}` : ""}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          </Card>

          <Card title="Used by">
            {prompt.used_by.length === 0 ? (
              <p className="text-xs text-muted">No benchmark profile was built from this prompt yet.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {prompt.used_by.map((u) => (
                  <li key={u.profile_id} className="flex flex-wrap items-center gap-x-2">
                    <Link href={`/profiles/${u.profile_id}`} className="font-medium hover:text-accent">
                      {u.profile_name}
                    </Link>
                    <span className="text-xs text-muted">
                      v{u.profile_version} uses prompt v{u.prompt_version}
                    </span>
                    {u.prompt_version < prompt.current_version && (
                      <span className="rounded bg-warning/15 px-1.5 text-[11px] text-warning">v{prompt.current_version} available</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function PromptPage() {
  return (
    <Suspense>
      <PromptPageInner />
    </Suspense>
  );
}
