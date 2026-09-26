// Typed client for the FastAPI backend (same-origin /api).

import { type BMQueryScope, scopeParams } from "./bmquery";
import { filenameFrom } from "./download";

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
export type RunMode = "realtime" | "batch";
export type RunParams = { max_tokens: number; temperature: number; concurrency: number; mode?: RunMode; batch_size?: number };

export type JsonSchema = { type?: string; properties?: Record<string, { type?: string; description?: string; enum?: unknown[] } & Record<string, unknown>>; required?: string[] } & Record<string, unknown>;

export type Prompt = {
  id: number;
  name: string;
  system_prompt: string | null;
  template: string;
  variables: string[];
  current_version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  profile_count: number;
  run_count: number;
  last_run_at: string | null;
};

export type PromptDetail = Prompt & {
  versions: { version: number; note: string | null; created_at: string; created_by: string | null; changed: string[]; profile_version_count: number }[];
  used_by: { profile_id: number; profile_name: string; current_version: number; profile_version: number; prompt_version: number }[];
};

export type PromptVersion = {
  version: number;
  system_prompt: string | null;
  template: string;
  note: string | null;
  created_at: string;
  created_by: string | null;
  variables: string[];
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
  description: string | null;
  schema: JsonSchema | null;
  run_count: number;
  expected_run_count: number;
  source: DatasetSource | null;
  connection_name: string | null;
};

/** Where an imported dataset came from (null = uploaded). */
export type DatasetSource = {
  connection_id: number;
  path?: string;
  table?: string;
  query?: string;
  rules?: FilterRule[];
  match?: "all" | "any";
  etag?: string | null;
  synced_at?: string;
  auto_refresh?: boolean;
};

export type ConnectionKind = "s3" | "postgres";
export type ConnectionProvider = "vultr" | "tiger" | "aws" | "other";
/** Result of an access check. write: null = not tested because the connection is read-only. */
export type ConnectionAccess = { read: boolean; write: boolean | null; detail: string; checked_at: string };
export type S3Config = { endpoint: string; region: string; bucket: string; prefix: string };
export type PgConfig = { host: string; port: number; database: string; user: string; sslmode: "require" | "verify-full" | "prefer" | "disable"; schema: string };
export type Connection = {
  id: number;
  name: string;
  kind: ConnectionKind;
  provider: ConnectionProvider;
  config: S3Config | PgConfig;
  allow_write: boolean;
  access: ConnectionAccess | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  dataset_count: number;
};
export type ConnectionIn = {
  name: string;
  kind: ConnectionKind;
  provider: ConnectionProvider;
  config: S3Config | PgConfig;
  secret: Record<string, string> | null;
  allow_write: boolean;
};
export type BrowseResult = { folder: string; folders: string[]; files: { path: string; size: number; modified: string }[]; truncated: boolean };
export type PgTable = { schema: string; name: string; type: string; columns: string[]; approx_rows: number; primary_key: string[] | null };
export type ImportIn = {
  path?: string;
  table?: string;
  query?: string;
  rules?: FilterRule[];
  match?: "all" | "any";
  name?: string;
  description?: string;
  auto_refresh?: boolean;
};

/** A connection's table read directly as a record source (streamed during the run, never copied). */
export type LinkedSource = { connection_id: number; table: string; key: string };
export type ParseAs = "auto" | "text" | "integer" | "number" | "boolean" | "json";
/** One column that reaches the prompt: its name in the record JSON and how it's parsed. */
export type FieldSpec = { column: string; name?: string | null; parse?: ParseAs; decimals?: number | null };
export type TableInfo = { columns: { name: string; type: string }[]; primary_key: string[]; approx_rows: number };

export type FilterOp = "eq" | "neq" | "in" | "not_in" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "empty" | "not_empty" | "regex";
export type FilterRule = { field: string; op: FilterOp; value: string };
/** Which records of a record source a run uses. Empty = all of them. */
export type RecordSelection = {
  rules?: FilterRule[];
  match?: "all" | "any";
  dedupe_on?: string | null;
  pick?: "all" | "first" | "random";
  n?: number | null;
  seed?: number;
};
export type SelectionPreview = {
  total: number;
  matched: number;
  unique: number;
  selected: number;
  description: string;
  rows: ({ idx: number } & Record<string, string>)[];
};

export type ValidationReport = { checked: number; invalid: number; errors: { row: number; field: string; message: string }[] };

export type DatasetDetail = Dataset & { rows: ({ idx: number } & Record<string, string>)[] };

export type RunListItem = {
  id: number;
  name: string | null;
  profile_id: number | null;
  profile_version: number | null;
  profile_name: string | null;
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
  top_model: string | null; // model with the best accuracy (ties: cheaper)
  total_cost_usd: number | null;
};

export type RunListQuery = {
  q?: string;
  status?: string;
  prompt_id?: number;
  profile_id?: number;
  version?: number;
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
  expected_dataset_id: number | null;
  expected_filename: string | null;
  input_key: string | null;
  expected_key: string | null;
  selection: RecordSelection;
  source: LinkedSource | null;
  fields: FieldSpec[] | null;
  rows: number;
};

export type Run = {
  id: number;
  bindings: Record<string, Binding & { filename?: string | null }>;
  expected_text: string | null;
  name: string | null;
  profile_id: number | null;
  profile_version: number | null;
  profile_name: string | null;
  profile_current_version: number | null;
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

export type DatasetRef = {
  dataset_id: number | null;
  mapping: Record<string, string>;
  expected_column: string | null;
  expected_dataset_id: number | null;
  input_key: string | null;
  expected_key: string | null;
  selection?: RecordSelection;
  source?: LinkedSource | null;
  fields?: FieldSpec[] | null;
};

/** A prompt variable that doesn't vary per record. */
export type Binding = { type: "text"; value: string } | { type: "dataset"; dataset_id: number; format: "json" | "jsonl" | "csv" };

/** Mapping value meaning "the whole record, as JSON". */
export const WHOLE_RECORD = "$record";

/** Everything a benchmark profile version stores (and a run needs). */
export type ProfileConfig = {
  prompt_id?: number | null; // the library prompt version the text came from
  prompt_version?: number | null;
  bindings: Record<string, Binding>;
  expected_text: string | null;
  prompt_name: string;
  system_prompt: string | null;
  template: string;
  datasets: DatasetRef[];
  scoring_method: ScoringMethod;
  scoring_config: Record<string, unknown>;
  model_ids: number[];
  mode: RunMode;
  batch_size: number;
} & RunParams;

export type ProfileVersion = {
  version: number;
  prompt_id: number | null;
  prompt_version: number | null;
  prompt: { id: number; name: string; current_version: number } | null;
  display_bindings: Record<string, Binding & { filename?: string | null }>;
  bindings: Record<string, Binding>;
  expected_text: string | null;
  prompt_name: string;
  system_prompt: string | null;
  template: string;
  variables: string[];
  scoring_method: ScoringMethod;
  scoring_config: Record<string, unknown>;
  model_ids: number[];
  params: RunParams;
  note: string | null;
  created_at: string;
  created_by_name: string | null;
  datasets: (RunDataset & {
    row_count: number | null;
    columns: string[] | null;
    format: string | null;
    available: boolean;
    expected_row_count: number | null;
    expected_columns: string[] | null;
    expected_format: string | null;
    expected_available: boolean;
  })[];
  models: { id: number; display_name: string; model_id: string; active: boolean }[];
};

export type ProfileSection = "prompt" | "inputs" | "scoring" | "models" | "params";

export type Profile = {
  id: number;
  name: string;
  description: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  current: ProfileVersion;
  export_connection_id: number | null;
  export_target: string | null;
  versions: { version: number; note: string | null; created_at: string; created_by: string | null; run_count: number; changed: ProfileSection[] }[];
};

export type RunExport = {
  id: number;
  connection_id: number | null;
  connection_name: string;
  target: string;
  status: "ok" | "failed";
  detail: string | null;
  rows: number | null;
  automatic: boolean;
  created_at: string;
  created_by: string | null;
};

export type ProfileListItem = {
  id: number;
  name: string;
  description: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  run_count: number;
  last_run_at: string | null;
  prompt_name: string;
  scoring_method: ScoringMethod;
  input_files: string[];
  model_count: number;
  current_best_accuracy: number | null;
};

/** Turn a stored version back into an editable config. */
export function versionToConfig(v: ProfileVersion): ProfileConfig {
  return {
    bindings: v.bindings ?? {},
    expected_text: v.expected_text,
    prompt_name: v.prompt_name,
    prompt_id: v.prompt_id,
    prompt_version: v.prompt_version,
    system_prompt: v.system_prompt,
    template: v.template,
    datasets: v.datasets
      .filter((d) => d.dataset_id || d.source)
      .map((d) => ({
        dataset_id: d.dataset_id,
        mapping: d.mapping,
        expected_column: d.expected_column,
        expected_dataset_id: d.expected_dataset_id,
        input_key: d.input_key,
        expected_key: d.expected_key,
        selection: d.selection,
        source: d.source,
        fields: d.fields,
      })),
    scoring_method: v.scoring_method,
    scoring_config: v.scoring_config,
    model_ids: v.model_ids,
    max_tokens: v.params.max_tokens ?? 4096,
    temperature: v.params.temperature ?? 0,
    concurrency: v.params.concurrency ?? 8,
    mode: v.params.mode ?? "realtime",
    batch_size: v.params.batch_size ?? 10,
  };
}

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
  processed_output: string | null;
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
  | { tool: "run_sql"; sql: string; source?: string | null; columns?: string[]; rows?: unknown[][]; truncated?: boolean; error?: string }
  | { tool: "query"; title?: string | null; sql: string; source?: string | null; error?: string } // written, not run
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

export type SavedQuery = { id: number; name: string; sql: string; connection_id: number | null; connection_name?: string | null; created_by?: string | null; updated_at: string };

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
  prompt: (id: number | string) => request<PromptDetail>(`/prompts/${id}`),
  promptVersion: (id: number | string, version: number) => request<PromptVersion>(`/prompts/${id}/versions/${version}`),
  restorePromptVersion: (id: number, version: number) => post<PromptDetail>(`/prompts/${id}/versions/${version}/restore`, {}),
  createPrompt: (body: { name: string; system_prompt?: string; template: string; note?: string }) => post<PromptDetail>("/prompts", body),
  updatePrompt: (id: number, body: { name: string; system_prompt?: string; template: string; note?: string }) => put<PromptDetail>(`/prompts/${id}`, body),
  deletePrompt: (id: number) => del<{ ok: boolean }>(`/prompts/${id}`),

  datasets: () => request<Dataset[]>("/datasets"),
  dataset: (id: number | string, limit = 20) => request<DatasetDetail>(`/datasets/${id}${qs({ limit })}`),
  uploadDataset: (file: File, name?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (name) form.append("name", name);
    return request<DatasetDetail>("/datasets", { method: "POST", body: form });
  },
  updateDataset: (id: number, body: { name: string; description?: string | null; schema?: JsonSchema; auto_refresh?: boolean }) => patch<DatasetDetail>(`/datasets/${id}`, body),
  connections: () => request<Connection[]>("/connections"),
  testConnection: (body: ConnectionIn) => post<ConnectionAccess>("/connections/test", body),
  createConnection: (body: ConnectionIn) => post<Connection>("/connections", body),
  updateConnection: (id: number, body: ConnectionIn) => put<Connection>(`/connections/${id}`, body),
  recheckConnection: (id: number) => post<Connection>(`/connections/${id}/check`, {}),
  deleteConnection: (id: number) => del<{ ok: boolean }>(`/connections/${id}`),
  browseConnection: (id: number, folder = "") => request<BrowseResult>(`/connections/${id}/browse?folder=${encodeURIComponent(folder)}`),
  tableInfo: (id: number, table: string) => request<TableInfo>(`/connections/${id}/table?name=${encodeURIComponent(table)}`),
  previewStream: (id: number, body: { table: string; key: string; selection: RecordSelection }) =>
    post<SelectionPreview & { columns: TableInfo["columns"] }>(`/connections/${id}/select`, body),
  connectionTables: (id: number) => request<PgTable[]>(`/connections/${id}/tables`),
  importFromConnection: (id: number, body: ImportIn) => post<{ id: number }>(`/connections/${id}/import`, body),
  refreshDataset: (id: number) => post<{ changed: boolean; row_count?: number; dataset: DatasetDetail }>(`/datasets/${id}/refresh`, {}),
  previewSelection: (id: number, selection: RecordSelection) => post<SelectionPreview>(`/datasets/${id}/select`, selection),
  validateDataset: (id: number, schema?: JsonSchema) => post<ValidationReport>(`/datasets/${id}/validate`, { schema }),
  inferSchema: (id: number) => request<JsonSchema>(`/datasets/${id}/infer-schema`),
  deleteDataset: (id: number) => del<{ ok: boolean }>(`/datasets/${id}`),

  profiles: () => request<ProfileListItem[]>("/profiles"),
  profile: (id: number | string) => request<Profile>(`/profiles/${id}`),
  profileVersion: (id: number | string, version: number) => request<ProfileVersion>(`/profiles/${id}/versions/${version}`),
  createProfile: (body: { name: string; description?: string; config: ProfileConfig; note?: string }) => post<Profile>("/profiles", body),
  updateProfileMeta: (id: number, body: { name: string; description?: string | null }) => patch<{ ok: boolean }>(`/profiles/${id}`, body),
  deleteProfile: (id: number) => del<{ ok: boolean }>(`/profiles/${id}`),
  duplicateProfile: (id: number, body: { name?: string; version?: number } = {}) => post<Profile>(`/profiles/${id}/duplicate`, body),
  saveVersion: (id: number, config: ProfileConfig, note?: string) =>
    post<{ version: number; changed: ProfileSection[] }>(`/profiles/${id}/versions`, { config, note }),
  restoreVersion: (id: number, version: number) => post<{ version: number }>(`/profiles/${id}/versions/${version}/restore`, {}),
  runProfile: (id: number, body: { version?: number; name?: string; output_name?: string } = {}) =>
    post<{ id: number; version: number }>(`/profiles/${id}/runs`, body),

  setProfileExport: (id: number, body: { connection_id: number | null; target?: string | null }) =>
    put<{ export_connection_id: number | null; export_target: string | null }>(`/profiles/${id}/export`, body),
  exportRun: (id: number, body: { connection_id: number; target?: string | null }) =>
    post<{ id: number; target: string; detail: string; rows: number }>(`/runs/${id}/exports`, body),
  runExports: (id: number) => request<RunExport[]>(`/runs/${id}/exports`),

  runs: (query: RunListQuery = {}) => request<{ total: number; items: RunListItem[] }>(`/runs${qs(query)}`),
  run: (id: number | string) => request<Run>(`/runs/${id}`),
  deleteRun: (id: number) => del<{ ok: boolean }>(`/runs/${id}`),
  results: (id: number | string, opts: { modelId?: number; onlyFailed?: boolean; limit?: number } = {}) =>
    request<Result[]>(`/runs/${id}/results${qs({ model_id: opts.modelId, only_failed: opts.onlyFailed || undefined, limit: opts.limit ?? 500 })}`),
  predictionsUrl: (id: number | string) => `/api/runs/${id}/predictions`,

  /** connectionId: query a Postgres connection instead of BenchMonster's own data. */
  query: (sql: string, connectionId: number | null = null) => post<QueryResult>("/query", { sql, connection_id: connectionId }),
  /** Run SQL and download every row (up to 50,000) as CSV or JSON. */
  exportQuery: async (sql: string, format: "csv" | "json", filename?: string, connectionId: number | null = null) => {
    const res = await fetch("/api/query/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, format, filename, connection_id: connectionId }),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        detail = (await res.json()).detail ?? detail;
      } catch {}
      throw new ApiError(detail, res.status);
    }
    return { blob: await res.blob(), filename: filenameFrom(res, `bmquery.${format}`), rows: Number(res.headers.get("x-row-count") ?? 0) };
  },
  schema: (connectionId: number | null = null) => request<SchemaTable[]>(`/query/schema${connectionId ? `?connection_id=${connectionId}` : ""}`),
  savedQueries: () => request<SavedQuery[]>("/saved-queries"),
  saveQuery: (name: string, sql: string, connectionId: number | null = null) => post<SavedQuery>("/saved-queries", { name, sql, connection_id: connectionId }),
  updateQuery: (id: number, name: string, sql: string, connectionId: number | null = null) =>
    put<SavedQuery>(`/saved-queries/${id}`, { name, sql, connection_id: connectionId }),
  deleteQuery: (id: number) => del<{ ok: boolean }>(`/saved-queries/${id}`),

  chatHistory: (scope: BMQueryScope) => request<ChatMessage[]>(`/bmquery/chat${scopeParams(scope)}`),
  chat: (scope: BMQueryScope, message: string) =>
    post<{ id: number; reply: string; tool_calls: ToolCall[] }>(`/bmquery/chat${scopeParams(scope)}`, { message }),

  voiceTurn: (scope: BMQueryScope, audio: Blob) => {
    const form = new FormData();
    const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
    form.append("audio", audio, `clip.${ext}`);
    return request<{ transcript: string; id: number; reply: string; tool_calls: ToolCall[] }>(`/bmquery/voice${scopeParams(scope)}`, {
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
