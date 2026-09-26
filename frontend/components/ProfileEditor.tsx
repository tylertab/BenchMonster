"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExpectedOutputCard, guessExpected, type InputSet, inputSetProblems, toRef } from "@/components/InputSetEditor";
import { DEFAULT_PARAMS, ModelPicker } from "@/components/ModelPicker";
import { buildScoringConfig, DEFAULT_SCORING, METHODS, OutputProcessing, ScoringConfig, scoringStateFrom, type ScoringState } from "@/components/ScoringConfig";
import { RecordFilter } from "@/components/RecordFilter";
import { VariableChips } from "@/components/TemplateView";
import { Button, Card, compactInputClass, Empty, ErrorNote, Field, inputClass } from "@/components/ui";
import {
  api,
  type Binding,
  type Dataset,
  type DatasetDetail,
  type ProfileConfig,
  type Prompt,
  type RunMode,
  type RunParams,
  type ScoringMethod,
  WHOLE_RECORD,
} from "@/lib/api";
import { isDefaultSelection } from "@/lib/selection";
import { renderTemplate, templateVariables } from "@/lib/template";

export type ProfileDraft = { name: string; description: string; config: ProfileConfig };

/** Where a prompt variable's value comes from. */
type VarSource = "field" | "record" | "dataset" | "text";
type InlineFormat = "json" | "jsonl" | "csv";

const SOURCE_LABEL: Record<VarSource, string> = {
  field: "Field",
  record: "Record",
  dataset: "Dataset",
  text: "Value",
};
const SOURCE_HINT: Record<VarSource, string> = {
  field: "One field of each record; one prompt per record",
  record: "All fields of each record as JSON; one prompt per record",
  dataset: "All records of a file, inlined into every prompt (catalogs, reference data)",
  text: "The same value in every prompt",
};

let nextKey = 0;
const newKey = () => `set-${++nextKey}`;

function resolveMapping(fieldVars: string[], wholeVars: string[], columns: string[], prev: Record<string, string> = {}) {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  return {
    ...Object.fromEntries(fieldVars.map((v) => [v, columns.includes(prev[v]) ? prev[v] : (lower.get(v.toLowerCase()) ?? "")])),
    ...Object.fromEntries(wholeVars.map((v) => [v, WHOLE_RECORD])),
  };
}

function newInputSet(d: Dataset): InputSet {
  const col = guessExpected(d.columns);
  return {
    key: newKey(), input: d, mapping: {}, expectedSource: col ? "column" : "none", expectedColumn: col,
    expectedDataset: null, matchBy: "key", inputKey: "", expectedKey: "", expectedValue: "row", selection: {},
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
 * Create or edit a benchmark profile, prompt first: every {{variable}} gets a
 * source (a record field, the whole record, a whole dataset, or fixed text).
 * In edit mode, saving creates a new version.
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
  const [runMode, setRunMode] = useState<RunMode>(initial?.config.mode ?? "realtime");
  const [batchSize, setBatchSize] = useState(initial?.config.batch_size ?? 10);

  const [promptName, setPromptName] = useState(initial?.config.prompt_name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.config.system_prompt ?? "");
  const [template, setTemplate] = useState(initial?.config.template ?? "");

  // Per-variable sources. Variables not listed default to "field".
  const initialSources: Record<string, VarSource> = {};
  for (const [v, b] of Object.entries(initial?.config.bindings ?? {})) initialSources[v] = b.type === "text" ? "text" : "dataset";
  for (const d of initial?.config.datasets ?? []) for (const [v, c] of Object.entries(d.mapping)) if (c === WHOLE_RECORD) initialSources[v] = "record";
  const [sources, setSources] = useState<Record<string, VarSource>>(initialSources);
  const [texts, setTexts] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(initial?.config.bindings ?? {}).flatMap(([v, b]) => (b.type === "text" ? [[v, b.value]] : []))),
  );
  const [inlines, setInlines] = useState<Record<string, { datasetId: number | null; format: InlineFormat }>>(
    Object.fromEntries(
      Object.entries(initial?.config.bindings ?? {}).flatMap(([v, b]) => (b.type === "dataset" ? [[v, { datasetId: b.dataset_id, format: b.format }]] : [])),
    ),
  );

  // A profile has at most one record source; every per-record variable reads it.
  const [sets, setSets] = useState<InputSet[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [expectedText, setExpectedText] = useState(initial?.config.expected_text ?? "");
  const [preview, setPreview] = useState<DatasetDetail | null>(null);

  const [method, setMethod] = useState<ScoringMethod>(initial?.config.scoring_method ?? "exact");
  const [scoring, setScoring] = useState<ScoringState>(initial ? scoringStateFrom(initial.config.scoring_config, initial.config.scoring_method) : DEFAULT_SCORING);
  const [modelIds, setModelIds] = useState<number[]>(initial?.config.model_ids ?? []);
  const [runParams, setRunParams] = useState<RunParams>(
    initial ? { max_tokens: initial.config.max_tokens, temperature: initial.config.temperature, concurrency: initial.config.concurrency } : DEFAULT_PARAMS,
  );
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
        const usable = initial.config.datasets.filter((r) => byId.has(r.dataset_id) && (!r.expected_dataset_id || byId.has(r.expected_dataset_id)));
        setDropped(usable.slice(1).map((r) => byId.get(r.dataset_id)!.filename));
        setSets(
          usable
            .slice(0, 1)
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
              selection: r.selection ?? {},
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
  const sourceOf = (v: string): VarSource => sources[v] ?? "field";
  const fieldVars = variables.filter((v) => sourceOf(v) === "field");
  const wholeVars = variables.filter((v) => sourceOf(v) === "record");
  const recordVars = [...fieldVars, ...wholeVars];
  const perRecord = recordVars.length > 0;
  const resolved = sets.map((s) => ({ ...s, mapping: resolveMapping(fieldVars, wholeVars, s.input.columns, s.mapping) }));
  const updateSet = (key: string, next: InputSet) => setSets((cur) => cur.map((s) => (s.key === key ? next : s)));
  const recordSet = resolved[0] ?? null;
  // Choosing a file for any per-record variable sets the record source for all of them.
  const chooseRecordFile = (id: number) => {
    const d = datasets?.find((x) => x.id === id);
    if (!d || recordSet?.input.id === id) return;
    setSets([newInputSet(d)]);
    setDropped([]);
  };
  const setColumn = (v: string, col: string) => recordSet && updateSet(recordSet.key, { ...recordSet, mapping: { ...recordSet.mapping, [v]: col } });
  const uploadFile = async (files: FileList) => {
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) addUploaded(await api.uploadDataset(f));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const addUploaded = (d: Dataset) => setDatasets((cur) => [d, ...(cur ?? []).filter((x) => x.id !== d.id)]);
  const byId = new Map((datasets ?? []).map((d) => [d.id, d]));

  const firstId = perRecord ? resolved[0]?.input.id : undefined;
  useEffect(() => {
    if (!firstId) return;
    let alive = true;
    api.dataset(firstId, 1).then((d) => alive && setPreview(d));
    return () => {
      alive = false;
    };
  }, [firstId]);
  const shownPreview = firstId && preview?.id === firstId ? preview : null;

  const bindings: Record<string, Binding> = {};
  for (const v of variables) {
    if (sourceOf(v) === "text") bindings[v] = { type: "text", value: texts[v] ?? "" };
    if (sourceOf(v) === "dataset" && inlines[v]?.datasetId) bindings[v] = { type: "dataset", dataset_id: inlines[v].datasetId!, format: inlines[v].format };
  }

  const methodInfo = METHODS.find((m) => m.value === method)!;
  const problems: string[] = [];
  if (!name.trim()) problems.push("Name the benchmark profile.");
  if (!promptName.trim()) problems.push("Name the prompt.");
  if (variables.length === 0) problems.push("The template needs at least one {{variable}}.");
  for (const v of variables) if (sourceOf(v) === "dataset" && !inlines[v]?.datasetId) problems.push(`Choose the dataset to inline for {{${v}}}.`);
  if (perRecord) {
    if (resolved.length === 0) problems.push(`Choose the file for ${recordVars.map((v) => `{{${v}}}`).join(", ")}.`);
    for (const s of resolved) {
      const unmapped = fieldVars.filter((v) => !s.mapping[v]);
      if (unmapped.length) problems.push(`Choose the field for ${unmapped.map((v) => `{{${v}}}`).join(", ")}.`);
      problems.push(...inputSetProblems(s, methodInfo.needsExpected, methodInfo.label));
    }
  } else if (methodInfo.needsExpected && !expectedText.trim()) {
    problems.push(`${methodInfo.label} scoring needs an expected output.`);
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
        config: {
          prompt_name: promptName.trim(),
          system_prompt: systemPrompt.trim() || null,
          template,
          bindings,
          datasets: perRecord ? resolved.map((s) => toRef(s, s.mapping)) : [],
          expected_text: perRecord ? null : expectedText.trim() || null,
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

  const previewValues: Record<string, string> | null =
    variables.length === 0
      ? null
      : Object.fromEntries(
          variables.map((v) => {
            const src = sourceOf(v);
            if (src === "text") return [v, texts[v] ?? ""];
            if (src === "dataset") return [v, inlines[v]?.datasetId ? `[dataset: ${byId.get(inlines[v].datasetId!)?.filename ?? "?"} as ${inlines[v].format}]` : `{{${v}}}`];
            const row = shownPreview?.rows[0];
            if (!row) return [v, `{{${v}}}`];
            if (src === "record") return [v, JSON.stringify(Object.fromEntries(resolved[0].input.columns.map((c) => [c, row[c]])))];
            return [v, row[resolved[0].mapping[v]] ?? `{{${v}}}`];
          }),
        );
  const totalInputs = perRecord ? resolved.reduce((a, s) => a + s.input.row_count, 0) : 1;
  const requestsPerModel = runMode === "batch" ? Math.ceil(totalInputs / batchSize) : totalInputs;

  return (
    <div className="space-y-6">
      <Section n={1} title="Profile">
        <div className="space-y-4">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Support ticket triage" />
          </Field>
          <Field label="Description" hint="Optional: what this benchmark measures, how its data was built, anything a teammate should know">
            <textarea
              rows={4}
              className={`${inputClass} resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this benchmark measures, where the inputs and expected outputs come from, and what a good result looks like."
            />
          </Field>
          <div>
            <span className="mb-1.5 block text-sm font-medium">Run mode</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["realtime", "Real-time", "One streaming request per prompt, in parallel. Measures per-prompt latency and time to first token."],
                  ["batch", "Batch (packed prompts)", "Several prompts per request; the model returns a JSON array of answers. Tests batch handling; shares tokens and cost."],
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
              <label className="mt-2 flex items-center gap-2 text-sm">
                <span className="text-ink-2">Prompts per request</span>
                <input type="number" min={2} max={50} aria-label="Inputs per request" className={`${compactInputClass} w-20`} value={batchSize} onChange={(e) => setBatchSize(Math.max(2, Math.min(50, Number(e.target.value) || 2)))} />
                <span className="text-xs text-muted">Max tokens (section 5) is per prompt; a request gets max tokens × prompts.</span>
              </label>
            )}
          </div>
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
          <Field label="Template" hint="Each {{variable}} becomes an input you connect in the next section">
            <textarea rows={10} className={`${inputClass} font-mono text-xs`} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder={"Catalog:\n{{catalog}}\n\nQuestion: {{question}}"} />
          </Field>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-2">Variables:</span>
            {variables.length ? <VariableChips variables={variables} /> : <span className="text-critical">none yet</span>}
          </div>
        </div>
      </Section>

      <Section
        n={3}
        title="Inputs"
        subtitle="where each variable's value comes from"
        actions={
          <label className="cursor-pointer text-xs text-accent hover:underline">
            <input type="file" multiple accept=".csv,.jsonl,.ndjson,.json" className="sr-only" onChange={(e) => e.target.files?.length && uploadFile(e.target.files)} />
            {uploading ? "Uploading…" : "+ Upload file"}
          </label>
        }
      >
        {variables.length === 0 ? (
          <p className="text-sm text-muted">Write the prompt first; each {"{{variable}}"} appears here to connect.</p>
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              {variables.map((v) => {
                const src = sourceOf(v);
                return (
                  <div key={v} className="rounded-md border border-line p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="min-w-32 text-sm text-accent">{`{{${v}}}`}</code>
                      <span className="text-muted">←</span>
                      <select className={compactInputClass} value={src} onChange={(e) => setSources({ ...sources, [v]: e.target.value as VarSource })} aria-label={`Source for ${v}`}>
                        {(Object.keys(SOURCE_LABEL) as VarSource[]).map((k) => (
                          <option key={k} value={k}>
                            {SOURCE_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      {(src === "field" || src === "record") && (
                        <>
                          <select
                            className={`${compactInputClass} max-w-64 ${recordSet ? "" : "border-critical"}`}
                            value={recordSet?.input.id ?? ""}
                            onChange={(e) => chooseRecordFile(Number(e.target.value))}
                            aria-label={`File for ${v}`}
                          >
                            <option value="">choose file…</option>
                            {datasets.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.filename} ({d.row_count} records)
                              </option>
                            ))}
                          </select>
                          {src === "field" && recordSet && (
                            <select
                              className={`${compactInputClass} ${recordSet.mapping[v] ? "" : "border-critical"}`}
                              value={recordSet.mapping[v] ?? ""}
                              onChange={(e) => setColumn(v, e.target.value)}
                              aria-label={`Column for ${v}`}
                            >
                              <option value="">choose field…</option>
                              {recordSet.input.columns.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                  {recordSet.input.schema?.properties?.[c]?.type ? ` (${recordSet.input.schema.properties[c].type})` : ""}
                                </option>
                              ))}
                            </select>
                          )}
                          {src === "record" && recordSet && <span className="text-xs text-ink-2">all {recordSet.input.columns.length} fields as JSON</span>}
                        </>
                      )}
                      {src === "dataset" && (
                        <>
                          <select
                            className={`${compactInputClass} max-w-64 ${inlines[v]?.datasetId ? "" : "border-critical"}`}
                            value={inlines[v]?.datasetId ?? ""}
                            onChange={(e) => setInlines({ ...inlines, [v]: { format: inlines[v]?.format ?? "json", datasetId: Number(e.target.value) || null } })}
                            aria-label={`Dataset for ${v}`}
                          >
                            <option value="">choose dataset…</option>
                            {datasets.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.filename} ({d.row_count} records)
                              </option>
                            ))}
                          </select>
                          <select
                            className={compactInputClass}
                            value={inlines[v]?.format ?? "json"}
                            onChange={(e) => setInlines({ ...inlines, [v]: { datasetId: inlines[v]?.datasetId ?? null, format: e.target.value as InlineFormat } })}
                            aria-label={`Format for ${v}`}
                          >
                            <option value="json">as JSON array</option>
                            <option value="jsonl">as JSON lines</option>
                            <option value="csv">as CSV</option>
                          </select>
                        </>
                      )}
                      <span className="ml-auto text-xs text-muted">{SOURCE_HINT[src]}</span>
                    </div>
                    {src === "text" && (
                      <textarea rows={2} className={`${inputClass} mt-2`} value={texts[v] ?? ""} onChange={(e) => setTexts({ ...texts, [v]: e.target.value })} placeholder={`Value of {{${v}}}`} aria-label={`Text for ${v}`} />
                    )}
                  </div>
                );
              })}
            </div>

            {perRecord ? (
              <div className="space-y-1 rounded-md bg-surface-2/60 px-3 py-2 text-sm text-ink-2">
                {recordSet ? (
                  <p>
                    {isDefaultSelection(recordSet.selection) ? (
                      <>
                        Each of the <strong>{recordSet.input.row_count.toLocaleString()} records</strong> in
                      </>
                    ) : (
                      <>
                        Each <strong>selected record</strong> (see below) in
                      </>
                    )}{" "}
                    <span className="font-mono">{recordSet.input.filename}</span> becomes one prompt; {recordVars.map((v) => `{{${v}}}`).join(", ")}{" "}
                    {recordVars.length === 1 ? "is" : "are"} read from the current record.
                  </p>
                ) : (
                  <p>Choose the file that {recordVars.map((v) => `{{${v}}}`).join(", ")} {recordVars.length === 1 ? "reads" : "read"} from; each of its records becomes one prompt.</p>
                )}
                {missing > 0 && <p className="text-warning">A dataset this version used was deleted; choose a file again.</p>}
                {dropped.length > 0 && (
                  <p className="text-warning">
                    This version also ran {dropped.join(", ")}. Profiles now use one record file; saving keeps only {recordSet?.input.filename}. Duplicate the profile to keep a
                    separate version for {dropped.join(", ")}.
                  </p>
                )}
                {recordSet && wholeVars.length > 0 && recordSet.expectedSource === "column" && recordSet.expectedColumn && (
                  <p className="text-critical">
                    The record includes the expected field <code>{recordSet.expectedColumn}</code>, so the answer would be in the prompt. Put expected outputs in a
                    separate file, or use individual fields instead.
                  </p>
                )}
              </div>
            ) : (
              <p className="rounded-md bg-surface-2/60 px-3 py-2 text-sm text-ink-2">
                No variable reads per-record data, so each run sends <strong>a single prompt</strong> per model.
              </p>
            )}

            {perRecord && recordSet && (
              <RecordFilter key={recordSet.input.id} dataset={recordSet.input} value={recordSet.selection} onChange={(sel) => updateSet(recordSet.key, { ...recordSet, selection: sel })} />
            )}

            {previewValues && (
              <div>
                <div className="mb-1 text-xs text-muted">Preview{perRecord && resolved[0] ? `: first record of ${resolved[0].input.filename}` : ""}</div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2/60 p-3 font-mono text-xs">{renderTemplate(template, previewValues)}</pre>
              </div>
            )}
            {datasets.length === 0 && (
              <p className="text-xs text-muted">
                Upload files on the{" "}
                <Link href="/datasets" className="text-accent underline">
                  Datasets
                </Link>{" "}
                page, or with + Upload file above.
              </p>
            )}
          </div>
        )}
      </Section>

      <Section n={4} title="Expected outputs" subtitle="how model replies are processed and compared">
        <div className="space-y-5">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Expected values</h3>
            {perRecord ? (
              resolved.length === 0 ? (
                <p className="text-xs text-muted">Choose the record file in Inputs first.</p>
              ) : (
                resolved.map((s) => <ExpectedOutputCard key={s.key} set={s} datasets={datasets} onChange={(next) => updateSet(s.key, next)} onUploaded={addUploaded} />)
              )
            ) : (
              <Field label="Expected output" hint="For the single prompt; optional with an LLM judge or schema check">
                <textarea rows={3} className={inputClass} value={expectedText} onChange={(e) => setExpectedText(e.target.value)} placeholder="PH-310" />
              </Field>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Processing the model&apos;s reply</h3>
            <OutputProcessing state={scoring} onChange={setScoring} />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Comparison with the expected value</h3>
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
        </div>
      </Section>

      <Section n={5} title="Models">
        <ModelPicker selected={modelIds} onChange={setModelIds} params={runParams} onParamsChange={setRunParams} />
      </Section>

      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {problems.length > 0 && <span className="mr-auto text-xs text-ink-2">{problems[0]}</span>}
        {modelIds.length > 0 && variables.length > 0 && (
          <span className="text-sm text-ink-2">
            {totalInputs.toLocaleString()} prompt{totalInputs === 1 ? "" : "s"} × {modelIds.length} model{modelIds.length === 1 ? "" : "s"} · {requestsPerModel.toLocaleString()} request
            {requestsPerModel === 1 ? "" : "s"} per model
          </span>
        )}
        <Button onClick={submit} disabled={busy || problems.length > 0}>
          {busy ? "Saving…" : mode === "create" ? "Create profile" : `Save as v${(initial?.currentVersion ?? 0) + 1}`}
        </Button>
      </div>
    </div>
  );
}

