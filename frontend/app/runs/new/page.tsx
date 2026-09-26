"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { DEFAULT_PARAMS, ModelPicker } from "@/components/ModelPicker";
import { buildScoringConfig, DEFAULT_SCORING, METHODS, ScoringConfig, scoringStateFrom, type ScoringState } from "@/components/ScoringConfig";
import { TemplateView, VariableChips } from "@/components/TemplateView";
import { Button, Card, compactInputClass, Empty, ErrorNote, Field, inputClass } from "@/components/ui";
import { api, type Dataset, type DatasetDetail, type Prompt, type RunParams, type ScoringMethod } from "@/lib/api";
import { renderTemplate, templateVariables } from "@/lib/template";

type Selected = { dataset: Dataset; mapping: Record<string, string>; expected: string };

const EXPECTED_GUESSES = ["expected", "expected_output", "answer", "output", "target", "label", "gold", "reference"];

function guessMapping(variables: string[], columns: string[], prev: Record<string, string> = {}) {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  return Object.fromEntries(variables.map((v) => [v, columns.includes(prev[v]) ? prev[v] : (lower.get(v.toLowerCase()) ?? "")]));
}
const guessExpected = (columns: string[]) => columns.find((c) => EXPECTED_GUESSES.includes(c.toLowerCase())) ?? "";

function Step({ n, title, children, actions }: { n: number; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-xs text-white">{n}</span>
          {title}
        </span>
      }
      actions={actions}
    >
      {children}
    </Card>
  );
}

function NewRun() {
  const router = useRouter();
  const params = useSearchParams();
  const fromRun = params.get("from");

  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [promptId, setPromptId] = useState<number | null>(null);
  const [override, setOverride] = useState<{ template: string; system_prompt: string } | null>(null);
  const [selected, setSelected] = useState<Selected[]>([]);
  const [preview, setPreview] = useState<DatasetDetail | null>(null);

  const [method, setMethod] = useState<ScoringMethod>("exact");
  const [scoring, setScoring] = useState<ScoringState>(DEFAULT_SCORING);
  const [modelIds, setModelIds] = useState<number[]>([]);
  const [runParams, setRunParams] = useState<RunParams>(DEFAULT_PARAMS);
  const [name, setName] = useState("");
  const [outputName, setOutputName] = useState("");
  const [cloneNote, setCloneNote] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const prompt = prompts?.find((p) => p.id === promptId) ?? null;
  const template = override?.template ?? prompt?.template ?? "";
  const variables = templateVariables(template);

  // Initial load, then prefill from ?prompt=, ?dataset=, or ?from= (clone).
  useEffect(() => {
    Promise.all([api.prompts(), api.datasets()]).then(async ([ps, ds]) => {
      setPrompts(ps);
      setDatasets(ds);
      const byId = new Map(ds.map((d) => [d.id, d]));
      if (fromRun) {
        const cfg = await api.runConfig(fromRun);
        if (cfg.prompt_id && ps.some((p) => p.id === cfg.prompt_id)) setPromptId(cfg.prompt_id);
        if (cfg.template !== cfg.current_template || (cfg.system_prompt ?? "") !== (cfg.current_system_prompt ?? "")) {
          setOverride({ template: cfg.template, system_prompt: cfg.system_prompt ?? "" });
          if (cfg.current_template !== null) setCloneNote(`Using the template exactly as run ID ${fromRun} used it; the saved prompt has changed since.`);
        }
        const missing = cfg.datasets.filter((d) => !d.dataset_id || !byId.has(d.dataset_id));
        if (missing.length) setCloneNote(`Some input files were deleted and are skipped: ${missing.map((d) => d.filename).join(", ")}`);
        setSelected(
          cfg.datasets
            .filter((d) => d.dataset_id && byId.has(d.dataset_id))
            .map((d) => ({ dataset: byId.get(d.dataset_id!)!, mapping: d.mapping, expected: d.expected_column ?? "" })),
        );
        setMethod(cfg.scoring_method);
        setScoring(scoringStateFrom(cfg.scoring_config));
        const models = await api.models();
        const available = new Set(models.map((m) => m.id));
        setModelIds(cfg.model_ids.filter((id) => available.has(id)));
        setRunParams({ ...DEFAULT_PARAMS, ...cfg.params });
        setName(cfg.name ? `${cfg.name} (rerun)` : "");
      } else {
        const p = Number(params.get("prompt"));
        if (p && ps.some((x) => x.id === p)) setPromptId(p);
        else if (ps.length === 1) setPromptId(ps[0].id);
        const d = byId.get(Number(params.get("dataset")));
        if (d) setSelected([{ dataset: d, mapping: {}, expected: guessExpected(d.columns) }]);
      }
    }, (e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep each dataset's mapping in sync with the template's variables.
  const effective = selected.map((s) => ({ ...s, mapping: guessMapping(variables, s.dataset.columns, s.mapping) }));

  // Preview the first rendered input of the first selected file.
  const firstId = effective[0]?.dataset.id;
  useEffect(() => {
    if (!firstId) return;
    let alive = true;
    api.dataset(firstId, 1).then((d) => alive && setPreview(d));
    return () => {
      alive = false;
    };
  }, [firstId]);
  const shownPreview = firstId && preview?.id === firstId ? preview : null;

  const toggleDataset = (d: Dataset) =>
    setSelected((cur) =>
      cur.some((s) => s.dataset.id === d.id) ? cur.filter((s) => s.dataset.id !== d.id) : [...cur, { dataset: d, mapping: {}, expected: guessExpected(d.columns) }],
    );
  const updateSelected = (id: number, patch: Partial<Selected>) => setSelected((cur) => cur.map((s) => (s.dataset.id === id ? { ...s, ...patch } : s)));

  const upload = async (files: FileList) => {
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const d = await api.uploadDataset(f);
        setDatasets((cur) => [d, ...cur]);
        setSelected((cur) => [...cur, { dataset: d, mapping: {}, expected: guessExpected(d.columns) }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const methodInfo = METHODS.find((m) => m.value === method)!;
  const totalInputs = effective.reduce((a, s) => a + s.dataset.row_count, 0);

  const problems: string[] = [];
  if (!prompt) problems.push("Pick a prompt.");
  if (prompt && variables.length === 0) problems.push("The template has no {{variables}}.");
  if (effective.length === 0) problems.push("Select at least one input file.");
  for (const s of effective) {
    const unmapped = variables.filter((v) => !s.mapping[v]);
    if (unmapped.length) problems.push(`${s.dataset.filename}: map ${unmapped.map((v) => `{{${v}}}`).join(", ")}.`);
    if (methodInfo.needsExpected && !s.expected) problems.push(`${s.dataset.filename}: ${methodInfo.label} scoring needs an expected column.`);
  }
  if (modelIds.length === 0) problems.push("Pick at least one model.");

  const submit = async () => {
    setError(null);
    if (problems.length) return setError(problems[0]);
    let scoringConfig;
    try {
      scoringConfig = buildScoringConfig(method, scoring);
    } catch (e) {
      return setError((e as Error).message);
    }
    setBusy(true);
    try {
      const run = await api.createRun({
        name: name.trim() || undefined,
        prompt_id: prompt!.id,
        template: override?.template,
        system_prompt: override ? override.system_prompt : undefined,
        datasets: effective.map((s) => ({ dataset_id: s.dataset.id, mapping: s.mapping, expected_column: s.expected || null })),
        scoring_method: method,
        scoring_config: scoringConfig,
        model_ids: modelIds,
        output_name: outputName.trim() || undefined,
        ...runParams,
      });
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (prompts === null) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  const previewValues = shownPreview?.rows[0] && effective[0] ? Object.fromEntries(variables.map((v) => [v, shownPreview.rows[0][effective[0].mapping[v]] ?? ""])) : null;
  const slug = (prompt?.name ?? "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{fromRun ? `Clone run ID ${fromRun}` : "New run"}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {fromRun ? (
            <>
              Prefilled from{" "}
              <Link href={`/runs/${fromRun}`} className="text-accent hover:underline">
                run ID {fromRun}
              </Link>
              . Change anything, then start a new run.
            </>
          ) : (
            "Run a prompt over one or more input files and compare models on the predictions."
          )}
        </p>
        {cloneNote && <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{cloneNote}</p>}
      </div>

      <Step
        n={1}
        title="Prompt"
        actions={
          <Link href="/prompts/new" className="text-xs text-accent hover:underline">
            + New prompt
          </Link>
        }
      >
        {prompts.length === 0 ? (
          <Empty>
            No prompts yet.{" "}
            <Link href="/prompts/new" className="text-accent underline">
              Create one first
            </Link>
            .
          </Empty>
        ) : (
          <div className="space-y-3">
            <select
              className={inputClass}
              value={promptId ?? ""}
              onChange={(e) => {
                setPromptId(Number(e.target.value) || null);
                setOverride(null);
                setCloneNote(null);
              }}
              aria-label="Prompt"
            >
              <option value="">Choose a prompt…</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {prompt &&
              (override ? (
                <div className="space-y-2">
                  <Field label="System prompt (this run only)">
                    <textarea rows={2} className={inputClass} value={override.system_prompt} onChange={(e) => setOverride({ ...override, system_prompt: e.target.value })} />
                  </Field>
                  <Field label="Template (this run only)">
                    <textarea rows={7} className={`${inputClass} font-mono text-xs`} value={override.template} onChange={(e) => setOverride({ ...override, template: e.target.value })} />
                  </Field>
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => (setOverride(null), setCloneNote(null))}>
                    Discard edits and use the saved prompt
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {prompt.system_prompt && <p className="text-xs text-ink-2">System: {prompt.system_prompt}</p>}
                  <div className="rounded-md bg-surface-2/60 p-3">
                    <TemplateView template={prompt.template} />
                  </div>
                  <button
                    type="button"
                    className="text-xs text-accent hover:underline"
                    onClick={() => setOverride({ template: prompt.template, system_prompt: prompt.system_prompt ?? "" })}
                  >
                    Edit for this run only
                  </button>
                </div>
              ))}
            {variables.length > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-ink-2">Inputs needed:</span>
                <VariableChips variables={variables} />
              </div>
            )}
          </div>
        )}
      </Step>

      <Step
        n={2}
        title="Input files"
        actions={
          <label className="cursor-pointer text-xs text-accent hover:underline">
            <input type="file" multiple accept=".csv,.jsonl,.ndjson,.json" className="sr-only" onChange={(e) => e.target.files?.length && upload(e.target.files)} />
            {uploading ? "Uploading…" : "+ Upload files"}
          </label>
        }
      >
        <div className="space-y-4">
          {datasets.length === 0 ? (
            <Empty>No datasets yet. Upload a CSV, JSONL, or JSON file.</Empty>
          ) : (
            <div className="flex flex-wrap gap-2">
              {datasets.map((d) => {
                const on = selected.some((s) => s.dataset.id === d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDataset(d)}
                    className={`rounded-md border px-2.5 py-1.5 text-left text-xs ${on ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2"}`}
                  >
                    <span className="font-mono font-medium">
                      {on ? "✓ " : ""}
                      {d.filename}
                    </span>
                    <span className="block text-muted">{d.row_count.toLocaleString()} rows</span>
                  </button>
                );
              })}
            </div>
          )}

          {effective.map((s) => (
            <div key={s.dataset.id} className="rounded-md border border-line p-3">
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="font-mono font-medium">{s.dataset.filename}</span>
                <span className="text-xs text-muted">{s.dataset.row_count.toLocaleString()} rows</span>
                <button type="button" className="ml-auto text-xs text-muted hover:text-critical" onClick={() => toggleDataset(s.dataset)}>
                  Remove
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {variables.map((v) => (
                  <label key={v} className="flex items-center gap-2 text-sm">
                    <code className="w-32 shrink-0 truncate text-xs text-accent">{`{{${v}}}`}</code>
                    <span className="text-muted">←</span>
                    <select
                      className={`${compactInputClass} min-w-0 flex-1 ${s.mapping[v] ? "" : "border-critical"}`}
                      value={s.mapping[v]}
                      onChange={(e) => updateSelected(s.dataset.id, { mapping: { ...s.mapping, [v]: e.target.value } })}
                      aria-label={`Column for ${v} in ${s.dataset.filename}`}
                    >
                      <option value="">choose column…</option>
                      {s.dataset.columns.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm">
                  <span className="w-32 shrink-0 text-xs text-ink-2">expected output</span>
                  <span className="text-muted">←</span>
                  <select
                    className={`${compactInputClass} min-w-0 flex-1`}
                    value={s.expected}
                    onChange={(e) => updateSelected(s.dataset.id, { expected: e.target.value })}
                    aria-label={`Expected column in ${s.dataset.filename}`}
                  >
                    <option value="">(none)</option>
                    {s.dataset.columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ))}

          {previewValues && (
            <div>
              <div className="mb-1 text-xs text-muted">Preview: first input of {effective[0].dataset.filename}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2/60 p-3 font-mono text-xs">{renderTemplate(template, previewValues)}</pre>
            </div>
          )}
        </div>
      </Step>

      <Step n={3} title="Output expectations">
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {METHODS.map((m) => (
              <button
                type="button"
                key={m.value}
                onClick={() => setMethod(m.value)}
                className={`rounded-md border p-2.5 text-left text-sm ${method === m.value ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2"}`}
              >
                <span className="block font-medium">{m.label}</span>
                <span className="mt-0.5 block text-xs text-ink-2">{m.description}</span>
              </button>
            ))}
          </div>
          <ScoringConfig method={method} state={scoring} onChange={setScoring} />
        </div>
      </Step>

      <Step n={4} title="Models">
        <ModelPicker selected={modelIds} onChange={setModelIds} params={runParams} onParamsChange={setRunParams} />
      </Step>

      <Step n={5} title="Output">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Run name" hint="Optional, shown in the runs list">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Baseline vs. new system prompt" />
          </Field>
          <Field label="Predictions file name" hint="Downloadable CSV of every prediction">
            <input className={`${inputClass} font-mono`} value={outputName} onChange={(e) => setOutputName(e.target.value)} placeholder={`${slug}-<timestamp>-predictions.csv`} />
          </Field>
        </div>
      </Step>

      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {problems.length > 0 && <span className="mr-auto text-xs text-ink-2">{problems[0]}</span>}
        {totalInputs > 0 && modelIds.length > 0 && (
          <span className="text-sm text-ink-2">
            {totalInputs.toLocaleString()} input{totalInputs === 1 ? "" : "s"} × {modelIds.length} model{modelIds.length === 1 ? "" : "s"} = {(totalInputs * modelIds.length).toLocaleString()} calls
          </span>
        )}
        <Button onClick={submit} disabled={busy || problems.length > 0}>
          {busy ? "Starting…" : "Start run"}
        </Button>
      </div>
    </div>
  );
}

export default function NewRunPage() {
  return (
    <Suspense>
      <NewRun />
    </Suspense>
  );
}
