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

export type ScoringMethod = "exact" | "contains" | "regex" | "numeric" | "json_schema" | "json_fields" | "llm_judge";
export type RunStatus = "queued" | "running" | "completed" | "failed";
export type RunParams = { max_tokens: number; temperature: number; concurrency: number };

export type Prompt = {
  id: number;
  name: string;
  system_prompt: string | null;
  template: string;
  variables: string[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
  run_count: number;
  last_run_at: string | null;
};

export type Dataset = {
  id: number;
  name: string;
  filename: string;
  format: string;
  columns: string[];
  row_count: number;
  created_at: string;
  created_by: string | null;
  run_count: number;
};

export type DatasetDetail = Dataset & { rows: ({ idx: number } & Record<string, string>)[] };

export type RunListItem = {
  id: number;
  name: string | null;
  status: RunStatus;
  prompt_id: number | null;
  prompt_name: string;
  template: string;
  output_name: string;
  scoring_method: ScoringMethod;
  total_inputs: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_by: string | null;
  input_files: string[];
  models: string[];
  done: number;
  best_accuracy: number | null;
  total_cost_usd: number | null;
};

export type RunListQuery = {
  q?: string;
  status?: string;
  prompt_id?: number;
  dataset_id?: number;
  model_id?: number;
  sort?: "newest" | "oldest";
  limit?: number;
  offset?: number;
};

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

export type RunDataset = {
  position: number;
  dataset_id: number | null;
  dataset_name: string;
  filename: string;
  mapping: Record<string, string>;
  expected_column: string | null;
  rows: number;
};

export type Run = {
  id: number;
  name: string | null;
  prompt_id: number | null;
  prompt_name: string;
  template: string;
  system_prompt: string | null;
  variables: string[];
  scoring_method: ScoringMethod;
  scoring_config: Record<string, unknown>;
  output_name: string;
  status: RunStatus;
  total_inputs: number;
  error: string | null;
  params: RunParams;
  created_at: string;
  created_by_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  datasets: RunDataset[];
  models: { id: number; display_name: string; model_id: string; provider: string; is_custom: boolean; done: number; errors: number }[];
  summary: ModelSummary[];
};

export type RunConfig = {
  name: string | null;
  prompt_id: number | null;
  prompt_name: string;
  template: string;
  system_prompt: string | null;
  current_template: string | null;
  current_system_prompt: string | null;
  scoring_method: ScoringMethod;
  scoring_config: Record<string, unknown>;
  params: RunParams;
  output_name: string;
  datasets: RunDataset[];
  model_ids: number[];
};

export type NewRun = {
  name?: string;
  prompt_id: number;
  template?: string;
  system_prompt?: string;
  datasets: { dataset_id: number; mapping: Record<string, string>; expected_column: string | null }[];
  scoring_method: ScoringMethod;
  scoring_config: Record<string, unknown>;
  model_ids: number[];
  output_name?: string;
} & RunParams;

export type Result = {
  id: number;
  model_id: number;
  model: string;
  input_file: string;
  row_idx: number;
  variables: Record<string, string>;
  prompt: string;
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

export type Role = "owner" | "admin";

export type Me = {
  user: { id: number; name: string; email: string };
  org: { id: number; name: string } | null;
  role: Role | null;
  orgs: { id: number; name: string; role: Role }[];
};

export type OrgDetails = {
  id: number;
  name: string;
  role: Role;
  members: { id: number; name: string; email: string; role: Role; created_at: string }[];
  invitations: { id: number; email: string; role: Role; created_at: string; expires_at: string }[];
};

export type SavedQuery = { id: number; name: string; sql: string; created_by?: string | null; updated_at: string };

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Fired on any 401 so the auth provider can send the user to /login. */
export const UNAUTHORIZED_EVENT = "bm:unauthorized";

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
    if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(detail, res.status);
  }
  return res.json();
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const api = {
  me: () => request<Me>("/auth/me"),
  signup: (body: { name: string; email: string; password: string; org_name?: string; invite_token?: string }) => post<Me>("/auth/signup", body),
  login: (body: { email: string; password: string }) => post<Me>("/auth/login", body),
  logout: () => post<{ ok: boolean }>("/auth/logout", {}),
  switchOrg: (org_id: number) => post<Me>("/auth/switch-org", { org_id }),
  createOrg: (name: string) => post<Me>("/orgs", { name }),

  org: () => request<OrgDetails>("/org"),
  renameOrg: (name: string) => patch<{ ok: boolean }>("/org", { name }),
  invite: (email: string, role: Role) => post<{ id: number; token: string; url: string }>("/org/invitations", { email, role }),
  revokeInvite: (id: number) => del<{ ok: boolean }>(`/org/invitations/${id}`),
  setRole: (userId: number, role: Role) => patch<{ ok: boolean }>(`/org/members/${userId}`, { role }),
  removeMember: (userId: number) => del<{ ok: boolean }>(`/org/members/${userId}`),
  invitation: (token: string) => request<{ org_name: string; email: string; role: Role }>(`/invitations/${token}`),
  acceptInvite: (token: string) => post<Me>(`/invitations/${token}/accept`, {}),

  memories: () => request<{ id: string; content: string; created_at: string | null }[]>("/memory"),
  forget: (id: string) => del<{ ok: boolean }>(`/memory/${id}`),

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
  removeModel: (id: number) => del<{ ok: boolean }>(`/models/${id}`),

  prompts: () => request<Prompt[]>("/prompts"),
  prompt: (id: number | string) => request<Prompt>(`/prompts/${id}`),
  createPrompt: (body: { name: string; system_prompt?: string; template: string }) => post<Prompt>("/prompts", body),
  updatePrompt: (id: number, body: { name: string; system_prompt?: string; template: string }) => put<Prompt>(`/prompts/${id}`, body),
  deletePrompt: (id: number) => del<{ ok: boolean }>(`/prompts/${id}`),

  datasets: () => request<Dataset[]>("/datasets"),
  dataset: (id: number | string, limit = 20) => request<DatasetDetail>(`/datasets/${id}${qs({ limit })}`),
  uploadDataset: (file: File, name?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (name) form.append("name", name);
    return request<DatasetDetail>("/datasets", { method: "POST", body: form });
  },
  deleteDataset: (id: number) => del<{ ok: boolean }>(`/datasets/${id}`),

  runs: (query: RunListQuery = {}) => request<{ total: number; items: RunListItem[] }>(`/runs${qs(query)}`),
  createRun: (body: NewRun) => post<{ id: number }>("/runs", body),
  run: (id: number | string) => request<Run>(`/runs/${id}`),
  runConfig: (id: number | string) => request<RunConfig>(`/runs/${id}/config`),
  deleteRun: (id: number) => del<{ ok: boolean }>(`/runs/${id}`),
  results: (id: number | string, opts: { modelId?: number; onlyFailed?: boolean; limit?: number } = {}) =>
    request<Result[]>(`/runs/${id}/results${qs({ model_id: opts.modelId, only_failed: opts.onlyFailed || undefined, limit: opts.limit ?? 500 })}`),
  predictionsUrl: (id: number | string) => `/api/runs/${id}/predictions`,

  query: (sql: string) => post<QueryResult>("/query", { sql }),
  schema: () => request<SchemaTable[]>("/query/schema"),
  savedQueries: () => request<SavedQuery[]>("/saved-queries"),
  saveQuery: (name: string, sql: string) => post<SavedQuery>("/saved-queries", { name, sql }),
  updateQuery: (id: number, name: string, sql: string) => put<SavedQuery>(`/saved-queries/${id}`, { name, sql }),
  deleteQuery: (id: number) => del<{ ok: boolean }>(`/saved-queries/${id}`),

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
    if (!res.ok) throw new ApiError(`text-to-speech failed (${res.status})`, res.status);
    return URL.createObjectURL(await res.blob());
  },
};
