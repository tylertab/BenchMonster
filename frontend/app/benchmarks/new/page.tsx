"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CaseEditor, type Case } from "@/components/CaseEditor";
import { DEFAULT_PARAMS, ModelPicker, type RunParams } from "@/components/ModelPicker";
import { buildScoringConfig, DEFAULT_SCORING, METHODS, ScoringConfig, scoringStateFrom, type ScoringState } from "@/components/ScoringConfig";
import { Button, Card, ErrorNote, Field, inputClass } from "@/components/ui";
import { api, type ParsedDataset, type RunConfig, type ScoringMethod } from "@/lib/api";

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

const mapRows = (d: ParsedDataset, inputCol: string, expectedCol: string): Case[] =>
  d.rows.map((r) => ({ input: r[inputCol] ?? "", expected: expectedCol ? (r[expectedCol] ?? null) : null }));

const norm = (v: string | null | undefined) => (v ?? "").trim();

// jsonb doesn't preserve key order, so compare configs with sorted keys.
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

/** True when the benchmark definition (not models/params) matches the cloned source. */
function sameBenchmark(src: RunConfig, b: { name: string; systemPrompt: string; template: string; method: ScoringMethod; config: Record<string, unknown>; cases: Case[] }) {
  return (
    src.name === b.name.trim() &&
    norm(src.system_prompt) === norm(b.systemPrompt) &&
    src.prompt_template === b.template &&
    src.scoring_method === b.method &&
    // Round-trip the source through the form so defaults compare equal ({tolerance} vs {tolerance, rel_tolerance: 0}).
    stable(buildScoringConfig(src.scoring_method, scoringStateFrom(src.scoring_config))) === stable(b.config) &&
    src.cases.length === b.cases.length &&
    src.cases.every((c, i) => c.input === b.cases[i].input && norm(c.expected) === norm(b.cases[i].expected))
  );
}

function NewBenchmark() {
  const router = useRouter();
  const fromRun = useSearchParams().get("from");
  const [source, setSource] = useState<RunConfig | null>(null);

  const [dataset, setDataset] = useState<ParsedDataset | null>(null);
  const [fileName, setFileName] = useState("");
  const [inputCol, setInputCol] = useState("");
  const [expectedCol, setExpectedCol] = useState("");
  const [cases, setCases] = useState<Case[]>([]);

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

  // Clone & edit: prefill everything from the source run.
  useEffect(() => {
    if (!fromRun) return;
    Promise.all([api.runConfig(fromRun), api.models()]).then(
      ([cfg, models]) => {
        setSource(cfg);
        setCases(cfg.cases);
        setFileName(`cloned from run #${fromRun}`);
        setName(cfg.name);
        setDescription(cfg.description ?? "");
        setSystemPrompt(cfg.system_prompt ?? "");
        setTemplate(cfg.prompt_template);
        setMethod(cfg.scoring_method);
        setScoring(scoringStateFrom(cfg.scoring_config));
        const available = new Set(models.map((m) => m.id));
        setModelIds(cfg.model_ids.filter((id) => available.has(id)));
        setParams({ ...DEFAULT_PARAMS, ...cfg.params });
      },
      (e) => setError(e.message),
    );
  }, [fromRun]);

  const loadFile = async (file: File) => {
    setError(null);
    try {
      const parsed = await api.parseDataset(file);
      const inCol = parsed.suggested_input;
      const exCol = parsed.suggested_expected ?? "";
      setDataset(parsed);
      setFileName(file.name);
      setInputCol(inCol);
      setExpectedCol(exCol);
      setCases(mapRows(parsed, inCol, exCol));
      if (!name) setName(file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remap = (inCol: string, exCol: string) => {
    setInputCol(inCol);
    setExpectedCol(exCol);
    if (dataset) setCases(mapRows(dataset, inCol, exCol));
  };

  const loadSample = async () => {
    const blob = await (await fetch(SAMPLE.url)).blob();
    await loadFile(new File([blob], SAMPLE.name));
    setMethod("numeric");
    setSystemPrompt("Solve the problem. End your reply with the final numeric answer only.");
  };

  const methodInfo = METHODS.find((m) => m.value === method)!;
  const hasExpected = cases.some((c) => norm(c.expected));

  const submit = async () => {
    setError(null);
    if (cases.length === 0) return setError("Add a dataset first.");
    if (cases.some((c) => !c.input.trim())) return setError("Every case needs an input (delete empty rows).");
    if (methodInfo.needsExpected && !hasExpected) return setError(`${methodInfo.label} scoring needs expected outputs.`);
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
      const runParams = { model_ids: modelIds, ...params };
      const reuse = source && sameBenchmark(source, { name, systemPrompt, template, method, config: scoringConfig, cases });
      const benchmarkId = reuse
        ? source.benchmark_id
        : (
            await api.createBenchmark({
              name: name.trim() || fileName,
              description: description.trim() || undefined,
              system_prompt: systemPrompt.trim() || undefined,
              prompt_template: template,
              scoring_method: method,
              scoring_config: scoringConfig,
              cases,
            })
          ).id;
      const run = await api.startRun(benchmarkId, runParams);
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const totalCalls = cases.length * modelIds.length;
  let previewConfig: Record<string, unknown> | null = null;
  try {
    previewConfig = buildScoringConfig(method, scoring);
  } catch {}
  const reusing = Boolean(source && previewConfig && sameBenchmark(source, { name, systemPrompt, template, method, config: previewConfig, cases }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{fromRun ? `Clone run #${fromRun}` : "Create benchmark"}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {fromRun ? (
            <>
              Everything from <Link href={`/runs/${fromRun}`} className="text-accent hover:underline">run #{fromRun}</Link> is prefilled. Edit anything, then start a new run.
            </>
          ) : (
            "Upload a dataset, describe what a good output looks like, and pick the models to compare."
          )}
        </p>
      </div>

      <Step n={1} title="Input dataset">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="cursor-pointer rounded-md border border-dashed border-line px-4 py-3 text-sm hover:bg-surface-2">
              <input type="file" accept=".csv,.jsonl,.ndjson,.json" className="sr-only" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
              {fileName ? `📄 ${fileName} · replace` : "Choose a CSV, JSONL, or JSON file"}
            </label>
            {!fromRun && (
              <Button type="button" variant="ghost" onClick={loadSample}>
                or use the sample dataset
              </Button>
            )}
            {cases.length === 0 && (
              <Button type="button" variant="ghost" onClick={() => setCases([{ input: "", expected: "" }])}>
                or type cases by hand
              </Button>
            )}
          </div>

          {dataset && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Input column" hint="Sent to the model as {input}">
                <select className={inputClass} value={inputCol} onChange={(e) => remap(e.target.value, expectedCol)}>
                  {dataset.columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Expected output column" hint="Changing columns re-reads the file (discards edits)">
                <select className={inputClass} value={expectedCol} onChange={(e) => remap(inputCol, e.target.value)}>
                  <option value="">(none)</option>
                  {dataset.columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {cases.length > 0 && <CaseEditor cases={cases} onChange={setCases} />}
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
          <Field label="Prompt template" hint="{input} is replaced by each case's input">
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
      <div className="flex flex-wrap items-center justify-end gap-3">
        {source && (
          <span className="mr-auto text-xs text-ink-2">
            {reusing
              ? `Benchmark unchanged: the new run joins "${source.name}" so runs stay comparable.`
              : "Dataset, prompts, or scoring changed: this creates a new benchmark."}
          </span>
        )}
        {totalCalls > 0 && <span className="text-sm text-ink-2">{totalCalls.toLocaleString()} model calls</span>}
        <Button onClick={submit} disabled={busy}>
          {busy ? "Starting…" : source ? "Start new run" : "Create & run benchmark"}
        </Button>
      </div>
    </div>
  );
}

export default function NewBenchmarkPage() {
  return (
    <Suspense>
      <NewBenchmark />
    </Suspense>
  );
}
