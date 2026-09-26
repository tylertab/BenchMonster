// Typed client for the FastAPI backend (same-origin /api).

export type Model = {
  id: number;
  provider: string;
  model_id: string;
  display_name: string;
  base_url: string;
  is_custom: boolean;
  active: boolean;
  input_cost_per_mtok: number;
  output_cost_per_mtok: number;
  context_length: number | null;
};

export type ScoringMethod = "exact" | "contains" | "regex" | "numeric" | "json_schema" | "llm_judge";

export type BenchmarkListItem = {
  id: number;
  name: string;
  description: string | null;
  scoring_method: ScoringMethod;
  created_at: string;
  case_count: number;
  run_count: number;
};

export type RunListItem = {
  id: number;
  status: RunStatus;
  total_cases: number;
  created_at: string;
  finished_at: string | null;
};

export type Benchmark = BenchmarkListItem & {
  system_prompt: string | null;
  prompt_template: string;
  scoring_config: Record<string, unknown>;
  sample_cases: { idx: number; input: string; expected: string | null }[];
  runs: RunListItem[];
};

export type RunStatus = "queued" | "running" | "completed" | "failed";

export type ModelSummary = {
  run_id: number;
  model: string;
  model_id: string;
  provider: string;
  cases: number;
  errors: number;
  accuracy: number | null;
  pass_rate: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  avg_ttft_ms: number | null;
  avg_tokens_per_sec: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  reasoning_tokens: number | null;
  total_cost_usd: number | null;
  cost_per_pass_usd: number | null;
};

export type Run = {
  id: number;
  benchmark_id: number;
  benchmark_name: string;
  scoring_method: ScoringMethod;
  status: RunStatus;
  total_cases: number;
  error: string | null;
  params: { max_tokens: number; temperature: number; concurrency: number };
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  models: { id: number; display_name: string; model_id: string; provider: string; is_custom: boolean; done: number; errors: number }[];
  summary: ModelSummary[];
};

export type Result = {
  id: number;
  model_id: number;
  model: string;
  case_idx: number;
  input: string;
  expected: string | null;
  output: string | null;
  score: number | null;
  passed: boolean | null;
  judge_rationale: string | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
};

export type ParsedDataset = {
  columns: string[];
  rows: Record<string, string>[];
  suggested_input: string;
  suggested_expected: string | null;
};

export type QueryResult = {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
};

export type SchemaTable = { name: string; columns: { name: string; type: string }[] };

export type ToolCall =
  | { tool: "run_sql"; sql: string; columns?: string[]; rows?: unknown[][]; truncated?: boolean; error?: string }
  | { tool: "save_finding"; finding: string; saved: boolean };

export type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  tool_calls: ToolCall[] | null;
  created_at?: string;
};

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {}
    throw new ApiError(detail);
  }
  return res.json();
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  models: () => request<Model[]>("/models"),
  syncModels: () => request<{ synced: number }>("/models/sync", { method: "POST" }),
  addModel: (body: {
    display_name: string;
    model_id: string;
    base_url: string;
    api_key?: string;
    input_cost_per_mtok: number;
    output_cost_per_mtok: number;
  }) => post<Model>("/models", body),
  removeModel: (id: number) => request<{ ok: boolean }>(`/models/${id}`, { method: "DELETE" }),

  parseDataset: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ParsedDataset>("/datasets/parse", { method: "POST", body: form });
  },
  benchmarks: () => request<BenchmarkListItem[]>("/benchmarks"),
  benchmark: (id: number | string) => request<Benchmark>(`/benchmarks/${id}`),
  createBenchmark: (body: {
    name: string;
    description?: string;
    system_prompt?: string;
    prompt_template: string;
    scoring_method: ScoringMethod;
    scoring_config: Record<string, unknown>;
    cases: { input: string; expected: string | null }[];
  }) => post<{ id: number }>("/benchmarks", body),
  startRun: (benchmarkId: number | string, body: { model_ids: number[]; max_tokens: number; temperature: number; concurrency: number }) =>
    post<{ id: number }>(`/benchmarks/${benchmarkId}/runs`, body),

  run: (id: number | string) => request<Run>(`/runs/${id}`),
  results: (id: number | string, opts: { modelId?: number; onlyFailed?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.modelId) q.set("model_id", String(opts.modelId));
    if (opts.onlyFailed) q.set("only_failed", "true");
    q.set("limit", String(opts.limit ?? 500));
    return request<Result[]>(`/runs/${id}/results?${q}`);
  },

  query: (sql: string) => post<QueryResult>("/query", { sql }),
  schema: () => request<SchemaTable[]>("/query/schema"),

  chatHistory: (runId: number | string) => request<ChatMessage[]>(`/runs/${runId}/chat`),
  chat: (runId: number | string, message: string) =>
    post<{ id: number; reply: string; tool_calls: ToolCall[] }>(`/runs/${runId}/chat`, { message }),

  voiceTurn: (runId: number | string, audio: Blob) => {
    const form = new FormData();
    const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
    form.append("audio", audio, `clip.${ext}`);
    return request<{ transcript: string; id: number; reply: string; tool_calls: ToolCall[] }>(`/runs/${runId}/voice`, {
      method: "POST",
      body: form,
    });
  },
  /** MP3 for the given text, as an object URL (caller revokes). */
  tts: async (text: string) => {
    const res = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new ApiError(`text-to-speech failed (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },
};
