"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEFAULT_PARAMS, ModelPicker, type RunParams } from "@/components/ModelPicker";
import { buildScoringConfig, DEFAULT_SCORING, METHODS, ScoringConfig, type ScoringState } from "@/components/ScoringConfig";
import { Button, Card, ErrorNote, Field, inputClass } from "@/components/ui";
import { api, type ParsedDataset, type ScoringMethod } from "@/lib/api";

const SAMPLE = { url: "/samples/math-word-problems.csv", name: "math-word-problems.csv" };

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-xs text-white">{n}</span>
          {title}
        </span>
      }
    >
      {children}
    </Card>
  );
}

export default function NewBenchmark() {
  const router = useRouter();
  const [dataset, setDataset] = useState<ParsedDataset | null>(null);
  const [fileName, setFileName] = useState("");
  const [inputCol, setInputCol] = useState("");
  const [expectedCol, setExpectedCol] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [template, setTemplate] = useState("{input}");
  const [method, setMethod] = useState<ScoringMethod>("llm_judge");
  const [scoring, setScoring] = useState<ScoringState>(DEFAULT_SCORING);

  const [modelIds, setModelIds] = useState<number[]>([]);
  const [params, setParams] = useState<RunParams>(DEFAULT_PARAMS);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadFile = async (file: File) => {
    setError(null);
    try {
      const parsed = await api.parseDataset(file);
      setDataset(parsed);
      setFileName(file.name);
      setInputCol(parsed.suggested_input);
      setExpectedCol(parsed.suggested_expected ?? "");
      if (!name) setName(file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadSample = async () => {
    const blob = await (await fetch(SAMPLE.url)).blob();
    await loadFile(new File([blob], SAMPLE.name));
    setMethod("numeric");
    setSystemPrompt("Solve the problem. End your reply with the final numeric answer only.");
  };

  const methodInfo = METHODS.find((m) => m.value === method)!;

  const submit = async () => {
    setError(null);
    if (!dataset) return setError("Upload a dataset first.");
    if (methodInfo.needsExpected && !expectedCol) return setError(`${methodInfo.label} scoring needs an expected-output column.`);
    if (!template.includes("{input}")) return setError("The prompt template must contain {input}.");
    if (modelIds.length === 0) return setError("Pick at least one model.");
    let scoringConfig;
    try {
      scoringConfig = buildScoringConfig(method, scoring);
    } catch (e) {
      return setError((e as Error).message);
    }
    setBusy(true);
    try {
      const bench = await api.createBenchmark({
        name: name.trim() || fileName,
        description: description.trim() || undefined,
        system_prompt: systemPrompt.trim() || undefined,
        prompt_template: template,
        scoring_method: method,
        scoring_config: scoringConfig,
        cases: dataset.rows.map((r) => ({ input: r[inputCol] ?? "", expected: expectedCol ? r[expectedCol] ?? null : null })),
      });
      const run = await api.startRun(bench.id, { model_ids: modelIds, ...params });
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const preview = dataset?.rows.slice(0, 5) ?? [];
  const totalCalls = (dataset?.rows.length ?? 0) * modelIds.length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create benchmark</h1>
        <p className="mt-1 text-sm text-ink-2">Upload a dataset, describe what a good output looks like, and pick the models to compare.</p>
      </div>

      <Step n={1} title="Input dataset">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="cursor-pointer rounded-md border border-dashed border-line px-4 py-3 text-sm hover:bg-surface-2">
              <input type="file" accept=".csv,.jsonl,.ndjson,.json" className="sr-only" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
              {fileName ? `📄 ${fileName} (${dataset?.rows.length} rows) · replace` : "Choose a CSV, JSONL, or JSON file"}
            </label>
            <Button type="button" variant="ghost" onClick={loadSample}>
              or use the sample dataset
            </Button>
          </div>

          {dataset && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Input column" hint="Sent to the model as {input}">
                  <select className={inputClass} value={inputCol} onChange={(e) => setInputCol(e.target.value)}>
                    {dataset.columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Expected output column">
                  <select className={inputClass} value={expectedCol} onChange={(e) => setExpectedCol(e.target.value)}>
                    <option value="">(none)</option>
                    {dataset.columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-surface-2 text-left text-muted">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">input</th>
                      <th className="px-2 py-1.5 font-medium">expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="max-w-md truncate px-2 py-1.5">{r[inputCol]}</td>
                        <td className="max-w-xs truncate px-2 py-1.5 text-ink-2">{expectedCol ? r[expectedCol] : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </Step>

      <Step n={2} title="Output expectations">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Benchmark name">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Support ticket triage" />
            </Field>
            <Field label="Description">
              <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
            </Field>
          </div>
          <Field label="System prompt" hint="Optional instructions sent with every case">
            <textarea rows={2} className={inputClass} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="You are a helpful assistant. Answer concisely." />
          </Field>
          <Field label="Prompt template" hint="{input} is replaced by each row's input">
            <textarea rows={2} className={`${inputClass} font-mono`} value={template} onChange={(e) => setTemplate(e.target.value)} />
          </Field>

          <div>
            <span className="mb-1.5 block text-sm font-medium">How should outputs be scored?</span>
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
          </div>
          <ScoringConfig method={method} state={scoring} onChange={setScoring} />
        </div>
      </Step>

      <Step n={3} title="Models to compare">
        <ModelPicker selected={modelIds} onChange={setModelIds} params={params} onParamsChange={setParams} />
      </Step>

      <ErrorNote error={error} />
      <div className="flex items-center justify-end gap-3">
        {totalCalls > 0 && <span className="text-sm text-ink-2">{totalCalls.toLocaleString()} model calls</span>}
        <Button onClick={submit} disabled={busy}>
          {busy ? "Starting…" : "Create & run benchmark"}
        </Button>
      </div>
    </div>
  );
}
