"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DEFAULT_PARAMS, ModelPicker } from "@/components/ModelPicker";
import { buildScoringConfig, DEFAULT_SCORING, METHODS, ScoringConfig, scoringStateFrom, type ScoringState } from "@/components/ScoringConfig";
import { VariableChips } from "@/components/TemplateView";
import { Button, Card, compactInputClass, Empty, ErrorNote, Field, inputClass } from "@/components/ui";
import { api, type Dataset, type DatasetDetail, type ProfileConfig, type Prompt, type RunParams, type ScoringMethod } from "@/lib/api";
import { renderTemplate, templateVariables } from "@/lib/template";

type Selected = { dataset: Dataset; mapping: Record<string, string>; expected: string };

export type ProfileDraft = { name: string; description: string; config: ProfileConfig; note: string };

const EXPECTED_GUESSES = ["expected", "expected_output", "answer", "output", "target", "label", "gold", "reference"];

function guessMapping(variables: string[], columns: string[], prev: Record<string, string> = {}) {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  return Object.fromEntries(variables.map((v) => [v, columns.includes(prev[v]) ? prev[v] : (lower.get(v.toLowerCase()) ?? "")]));
}
const guessExpected = (columns: string[]) => columns.find((c) => EXPECTED_GUESSES.includes(c.toLowerCase())) ?? "";

function Section({ n, title, children, actions }: { n: number; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
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

/**
 * Create or edit a benchmark profile's configuration: prompt, input sets,
 * output expectations, models. In edit mode, saving creates a new version.
 */
export function ProfileEditor({
  mode,
  initial,
  prefill,
  onSubmit,
}: {
  mode: "create" | "edit";
  initial?: { name: string; description: string | null; config: ProfileConfig; currentVersion?: number };
  prefill?: { promptId?: number; datasetId?: number };
  onSubmit: (draft: ProfileDraft) => Promise<void>;
}) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [missing, setMissing] = useState<number[]>([]);

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [promptName, setPromptName] = useState(initial?.config.prompt_name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.config.system_prompt ?? "");
  const [template, setTemplate] = useState(initial?.config.template ?? "");
  const [selected, setSelected] = useState<Selected[]>([]);
  const [preview, setPreview] = useState<DatasetDetail | null>(null);
  const [method, setMethod] = useState<ScoringMethod>(initial?.config.scoring_method ?? "exact");
  const [scoring, setScoring] = useState<ScoringState>(initial ? scoringStateFrom(initial.config.scoring_config, initial.config.scoring_method) : DEFAULT_SCORING);
  const [modelIds, setModelIds] = useState<number[]>(initial?.config.model_ids ?? []);
  const [runParams, setRunParams] = useState<RunParams>(
    initial ? { max_tokens: initial.config.max_tokens, temperature: initial.config.temperature, concurrency: initial.config.concurrency } : DEFAULT_PARAMS,
  );
  const [note, setNote] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadPrompt = (p: Prompt) => {
    setPromptName(p.name);
    setSystemPrompt(p.system_prompt ?? "");
    setTemplate(p.template);
    setName((n) => n || p.name);
  };

  useEffect(() => {
    Promise.all([api.prompts(), api.datasets()]).then(([ps, ds]) => {
      setPrompts(ps);
      setDatasets(ds);
      const byId = new Map(ds.map((d) => [d.id, d]));
      if (initial) {
        setMissing(initial.config.datasets.filter((r) => !byId.has(r.dataset_id)).map((r) => r.dataset_id));
        setSelected(
          initial.config.datasets
            .filter((r) => byId.has(r.dataset_id))
            .map((r) => ({ dataset: byId.get(r.dataset_id)!, mapping: r.mapping, expected: r.expected_column ?? "" })),
        );
      } else {
        const p = ps.find((x) => x.id === prefill?.promptId);
        if (p) loadPrompt(p);
        const d = prefill?.datasetId ? byId.get(prefill.datasetId) : undefined;
        if (d) setSelected([{ dataset: d, mapping: {}, expected: guessExpected(d.columns) }]);
      }
    }, (e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const variables = templateVariables(template);
  const effective = selected.map((s) => ({ ...s, mapping: guessMapping(variables, s.dataset.columns, s.mapping) }));

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
        setDatasets((cur) => [d, ...(cur ?? [])]);
        setSelected((cur) => [...cur, { dataset: d, mapping: {}, expected: guessExpected(d.columns) }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const methodInfo = METHODS.find((m) => m.value === method)!;
  const problems: string[] = [];
  if (!name.trim()) problems.push("Name the benchmark profile.");
  if (!promptName.trim()) problems.push("Name the prompt.");
  if (variables.length === 0) problems.push("The template needs at least one {{variable}}.");
  if (effective.length === 0) problems.push("Add at least one input set.");
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
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        note: note.trim(),
        config: {
          prompt_name: promptName.trim(),
          system_prompt: systemPrompt.trim() || null,
          template,
          datasets: effective.map((s) => ({ dataset_id: s.dataset.id, mapping: s.mapping, expected_column: s.expected || null })),
          scoring_method: method,
          scoring_config: scoringConfig,
          model_ids: modelIds,
          ...runParams,
        },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (datasets === null) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  const previewValues = shownPreview?.rows[0] && effective[0] ? Object.fromEntries(variables.map((v) => [v, shownPreview.rows[0][effective[0].mapping[v]] ?? ""])) : null;
  const totalInputs = effective.reduce((a, s) => a + s.dataset.row_count, 0);

  return (
    <div className="space-y-6">
      <Section n={1} title="Profile">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Support ticket triage" />
          </Field>
          <Field label="Description" hint="Optional">
            <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this benchmark measures" />
          </Field>
        </div>
      </Section>

      <Section
        n={2}
        title="Prompt"
        actions={
          prompts.length > 0 && (
            <select
              className={`${compactInputClass} max-w-56 py-1 text-xs`}
              value=""
              onChange={(e) => {
                const p = prompts.find((x) => x.id === Number(e.target.value));
                if (p) loadPrompt(p);
              }}
              aria-label="Load from prompt library"
            >
              <option value="">Load from prompt library…</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )
        }
      >
        <div className="space-y-3">
          <Field label="Prompt name" hint="Shown in runs and SQL (prompt_name); rename it when you change the prompt to compare versions">
            <input className={inputClass} value={promptName} onChange={(e) => setPromptName(e.target.value)} placeholder="Triage rules v1" />
          </Field>
          <Field label="System prompt" hint="Optional">
            <textarea rows={2} className={inputClass} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </Field>
          <Field label="Template" hint="{{variable}} placeholders are filled from each input set's columns">
            <textarea rows={10} className={`${inputClass} font-mono text-xs`} value={template} onChange={(e) => setTemplate(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-2">Variables:</span>
            {variables.length ? <VariableChips variables={variables} /> : <span className="text-critical">none yet</span>}
          </div>
        </div>
      </Section>

      <Section
        n={3}
        title="Input sets"
        actions={
          <label className="cursor-pointer text-xs text-accent hover:underline">
            <input type="file" multiple accept=".csv,.jsonl,.ndjson,.json" className="sr-only" onChange={(e) => e.target.files?.length && upload(e.target.files)} />
            {uploading ? "Uploading…" : "+ Upload files"}
          </label>
        }
      >
        <div className="space-y-4">
          {missing.length > 0 && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              {missing.length} input set{missing.length === 1 ? " was" : "s were"} deleted and {missing.length === 1 ? "is" : "are"} left out of this version.
            </p>
          )}
          {datasets.length === 0 ? (
            <Empty>
              No datasets yet. Upload a CSV, JSONL, or JSON file, or add them on the{" "}
              <Link href="/datasets" className="text-accent underline">
                Datasets
              </Link>{" "}
              page.
            </Empty>
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
      </Section>

      <Section n={4} title="Output expectations">
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
      </Section>

      <Section n={5} title="Models">
        <ModelPicker selected={modelIds} onChange={setModelIds} params={runParams} onParamsChange={setRunParams} />
      </Section>

      {mode === "edit" && (
        <Card>
          <Field label="What changed?" hint={`Saved as version ${(initial?.currentVersion ?? 0) + 1}. Earlier versions and their runs stay as they are.`}>
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shorter rules section; added examples" />
          </Field>
        </Card>
      )}

      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {problems.length > 0 && <span className="mr-auto text-xs text-ink-2">{problems[0]}</span>}
        {totalInputs > 0 && modelIds.length > 0 && (
          <span className="text-sm text-ink-2">
            {totalInputs.toLocaleString()} input{totalInputs === 1 ? "" : "s"} × {modelIds.length} model{modelIds.length === 1 ? "" : "s"} per run
          </span>
        )}
        <Button onClick={submit} disabled={busy || problems.length > 0}>
          {busy ? "Saving…" : mode === "create" ? "Create profile" : `Save as v${(initial?.currentVersion ?? 0) + 1}`}
        </Button>
      </div>
    </div>
  );
}
