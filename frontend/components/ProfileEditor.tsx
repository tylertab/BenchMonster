"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DatasetPicker, guessExpected, type InputSet, InputSetCard, inputSetProblems, toRef } from "@/components/InputSetEditor";
import { DEFAULT_PARAMS, ModelPicker } from "@/components/ModelPicker";
import { buildScoringConfig, DEFAULT_SCORING, METHODS, ScoringConfig, scoringStateFrom, type ScoringState } from "@/components/ScoringConfig";
import { VariableChips } from "@/components/TemplateView";
import { Button, Card, compactInputClass, Empty, ErrorNote, Field, inputClass } from "@/components/ui";
import { api, type Dataset, type DatasetDetail, type ProfileConfig, type Prompt, type RunMode, type RunParams, type ScoringMethod } from "@/lib/api";
import { renderTemplate, templateVariables } from "@/lib/template";

export type ProfileDraft = { name: string; description: string; config: ProfileConfig; note: string };

let nextKey = 0;
const newKey = () => `set-${++nextKey}`;

function resolveMapping(variables: string[], columns: string[], prev: Record<string, string> = {}) {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  return Object.fromEntries(variables.map((v) => [v, columns.includes(prev[v]) ? prev[v] : (lower.get(v.toLowerCase()) ?? "")]));
}

function newInputSet(d: Dataset): InputSet {
  const col = guessExpected(d.columns);
  return {
    key: newKey(), input: d, mapping: {}, expectedSource: col ? "column" : "none", expectedColumn: col,
    expectedDataset: null, matchBy: "key", inputKey: "", expectedKey: "", expectedValue: "row",
  };
}

function Section({ n, title, subtitle, children, actions }: { n: number; title: string; subtitle?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-xs text-white">{n}</span>
          {title}
          {subtitle && <span className="font-normal text-muted">· {subtitle}</span>}
        </span>
      }
      actions={actions}
    >
      {children}
    </Card>
  );
}

/**
 * Create or edit a benchmark profile: inputs & expected outputs, prompt,
 * comparison, execution. In edit mode, saving creates a new version.
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
  const [missing, setMissing] = useState(0);

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sets, setSets] = useState<InputSet[]>([]);
  const [adding, setAdding] = useState(false);
  const [promptName, setPromptName] = useState(initial?.config.prompt_name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.config.system_prompt ?? "");
  const [template, setTemplate] = useState(initial?.config.template ?? "");
  const [preview, setPreview] = useState<DatasetDetail | null>(null);
  const [method, setMethod] = useState<ScoringMethod>(initial?.config.scoring_method ?? "json_fields");
  const [scoring, setScoring] = useState<ScoringState>(initial ? scoringStateFrom(initial.config.scoring_config, initial.config.scoring_method) : DEFAULT_SCORING);
  const [modelIds, setModelIds] = useState<number[]>(initial?.config.model_ids ?? []);
  const [runParams, setRunParams] = useState<RunParams>(
    initial ? { max_tokens: initial.config.max_tokens, temperature: initial.config.temperature, concurrency: initial.config.concurrency } : DEFAULT_PARAMS,
  );
  const [runMode, setRunMode] = useState<RunMode>(initial?.config.mode ?? "realtime");
  const [batchSize, setBatchSize] = useState(initial?.config.batch_size ?? 10);
  const [note, setNote] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        setMissing(initial.config.datasets.filter((r) => !byId.has(r.dataset_id) || (r.expected_dataset_id && !byId.has(r.expected_dataset_id))).length);
        setSets(
          initial.config.datasets
            .filter((r) => byId.has(r.dataset_id) && (!r.expected_dataset_id || byId.has(r.expected_dataset_id)))
            .map((r) => ({
              key: newKey(),
              input: byId.get(r.dataset_id)!,
              mapping: r.mapping,
              expectedSource: r.expected_dataset_id ? "dataset" : r.expected_column ? "column" : "none",
              expectedColumn: r.expected_column ?? "",
              expectedDataset: r.expected_dataset_id ? byId.get(r.expected_dataset_id)! : null,
              matchBy: r.input_key ? "key" : "order",
              inputKey: r.input_key ?? "",
              expectedKey: r.expected_key ?? "",
              expectedValue: r.expected_dataset_id && r.expected_column ? "column" : "row",
            })),
        );
      } else {
        const p = ps.find((x) => x.id === prefill?.promptId);
        if (p) loadPrompt(p);
        const d = prefill?.datasetId ? byId.get(prefill.datasetId) : undefined;
        if (d) setSets([newInputSet(d)]);
      }
    }, (e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const variables = templateVariables(template);
  const resolved = sets.map((s) => ({ ...s, mapping: resolveMapping(variables, s.input.columns, s.mapping) }));
  const updateSet = (key: string, next: InputSet) => setSets((cur) => cur.map((s) => (s.key === key ? next : s)));
  const addUploaded = (d: Dataset) => setDatasets((cur) => [d, ...(cur ?? []).filter((x) => x.id !== d.id)]);

  const firstId = resolved[0]?.input.id;
  useEffect(() => {
    if (!firstId) return;
    let alive = true;
    api.dataset(firstId, 1).then((d) => alive && setPreview(d));
    return () => {
      alive = false;
    };
  }, [firstId]);
  const shownPreview = firstId && preview?.id === firstId ? preview : null;

  const methodInfo = METHODS.find((m) => m.value === method)!;
  const problems: string[] = [];
  if (!name.trim()) problems.push("Name the benchmark profile.");
  if (resolved.length === 0) problems.push("Add at least one input.");
  for (const s of resolved) problems.push(...inputSetProblems(s, methodInfo.needsExpected, methodInfo.label));
  if (!promptName.trim()) problems.push("Name the prompt.");
  if (variables.length === 0) problems.push("The template needs at least one {{variable}}.");
  for (const s of resolved) {
    const unmapped = variables.filter((v) => !s.mapping[v]);
    if (unmapped.length) problems.push(`${s.input.filename}: map ${unmapped.map((v) => `{{${v}}}`).join(", ")} in the Prompt section.`);
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
          datasets: resolved.map((s) => toRef(s, s.mapping)),
          scoring_method: method,
          scoring_config: scoringConfig,
          model_ids: modelIds,
          ...runParams,
          mode: runMode,
          batch_size: batchSize,
        },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (datasets === null) return error ? <ErrorNote error={error} /> : <Empty>Loading…</Empty>;

  const previewValues = shownPreview?.rows[0] && resolved[0] ? Object.fromEntries(variables.map((v) => [v, shownPreview.rows[0][resolved[0].mapping[v]] ?? ""])) : null;
  const totalInputs = resolved.reduce((a, s) => a + s.input.row_count, 0);
  const requestsPerModel = runMode === "batch" ? Math.ceil(totalInputs / batchSize) : totalInputs;

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

      <Section n={2} title="Inputs & expected outputs" subtitle="datasets">
        <div className="space-y-3">
          {missing > 0 && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              {missing} input set{missing === 1 ? " uses" : "s use"} a deleted dataset and {missing === 1 ? "is" : "are"} left out of this version.
            </p>
          )}
          {resolved.map((s) => (
            <InputSetCard
              key={s.key}
              set={s}
              datasets={datasets}
              onChange={(next) => updateSet(s.key, next)}
              onRemove={() => setSets((cur) => cur.filter((x) => x.key !== s.key))}
              onUploaded={addUploaded}
            />
          ))}
          {adding ? (
            <DatasetPicker
              title="Choose an input file"
              datasets={datasets}
              onPick={(d) => {
                setSets((cur) => [...cur, newInputSet(d)]);
                setAdding(false);
              }}
              onUploaded={(d) => {
                addUploaded(d);
                setSets((cur) => [...cur, newInputSet(d)]);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
              + Add input
            </Button>
          )}
          {datasets.length === 0 && !adding && (
            <p className="text-xs text-muted">
              Tip: manage files and their schemas on the{" "}
              <Link href="/datasets" className="text-accent underline">
                Datasets
              </Link>{" "}
              page.
            </p>
          )}
        </div>
      </Section>

      <Section
        n={3}
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
          <Field label="Template" hint="{{variable}} placeholders are filled from each input's columns">
            <textarea rows={10} className={`${inputClass} font-mono text-xs`} value={template} onChange={(e) => setTemplate(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-2">Variables:</span>
            {variables.length ? <VariableChips variables={variables} /> : <span className="text-critical">none yet</span>}
          </div>

          {variables.length > 0 &&
            resolved.map((s) => (
              <div key={s.key} className="rounded-md border border-line p-2.5">
                <div className="mb-1.5 font-mono text-xs text-ink-2">{s.input.filename}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {variables.map((v) => (
                    <label key={v} className="flex items-center gap-2 text-sm">
                      <code className="w-32 shrink-0 truncate text-xs text-accent">{`{{${v}}}`}</code>
                      <span className="text-muted">←</span>
                      <select
                        className={`${compactInputClass} min-w-0 flex-1 ${s.mapping[v] ? "" : "border-critical"}`}
                        value={s.mapping[v]}
                        onChange={(e) => updateSet(s.key, { ...s, mapping: { ...s.mapping, [v]: e.target.value } })}
                        aria-label={`Column for ${v} in ${s.input.filename}`}
                      >
                        <option value="">choose column…</option>
                        {s.input.columns.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            ))}

          {previewValues && (
            <div>
              <div className="mb-1 text-xs text-muted">Preview: first input of {resolved[0].input.filename}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2/60 p-3 font-mono text-xs">{renderTemplate(template, previewValues)}</pre>
            </div>
          )}
        </div>
      </Section>

      <Section n={4} title="Comparison" subtitle="how outputs are scored against expected outputs">
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

      <Section n={5} title="Execution" subtitle="models and how requests are sent">
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["realtime", "Real-time", "One streaming request per input, in parallel. Measures per-input latency and time to first token."],
                ["batch", "Batch (packed prompts)", "Several inputs per request; the model returns a JSON array of answers. Tests batch handling; shares tokens and cost."],
              ] as [RunMode, string, string][]
            ).map(([value, label, desc]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRunMode(value)}
                className={`rounded-md border p-2.5 text-left text-sm ${runMode === value ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2"}`}
              >
                <span className="block font-medium">{label}</span>
                <span className="mt-0.5 block text-xs text-ink-2">{desc}</span>
              </button>
            ))}
          </div>
          {runMode === "batch" && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-ink-2">Inputs per request</span>
              <input type="number" min={2} max={50} aria-label="Inputs per request" className={`${compactInputClass} w-20`} value={batchSize} onChange={(e) => setBatchSize(Math.max(2, Math.min(50, Number(e.target.value) || 2)))} />
              <span className="text-xs text-muted">Max tokens below is per input; a request gets max tokens × inputs.</span>
            </label>
          )}
          <ModelPicker selected={modelIds} onChange={setModelIds} params={runParams} onParamsChange={setRunParams} />
        </div>
      </Section>

      {mode === "edit" && (
        <Card>
          <Field label="What changed?" hint={`Saved as version ${(initial?.currentVersion ?? 0) + 1}. Earlier versions and their runs stay as they are.`}>
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Expected outputs moved to their own file; batch mode" />
          </Field>
        </Card>
      )}

      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {problems.length > 0 && <span className="mr-auto text-xs text-ink-2">{problems[0]}</span>}
        {totalInputs > 0 && modelIds.length > 0 && (
          <span className="text-sm text-ink-2">
            {totalInputs.toLocaleString()} input{totalInputs === 1 ? "" : "s"} × {modelIds.length} model{modelIds.length === 1 ? "" : "s"} ·{" "}
            {requestsPerModel.toLocaleString()} request{requestsPerModel === 1 ? "" : "s"} per model
          </span>
        )}
        <Button onClick={submit} disabled={busy || problems.length > 0}>
          {busy ? "Saving…" : mode === "create" ? "Create profile" : `Save as v${(initial?.currentVersion ?? 0) + 1}`}
        </Button>
      </div>
    </div>
  );
}
