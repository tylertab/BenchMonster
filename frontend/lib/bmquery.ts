// BMQuery scopes: the whole org, one benchmark profile, or one run.

export type BMQueryScope = { kind: "org" } | { kind: "profile"; profileId: number } | { kind: "run"; runId: number };

export const scopeParams = (s: BMQueryScope) =>
  s.kind === "profile" ? `?profile_id=${s.profileId}` : s.kind === "run" ? `?run_id=${s.runId}` : "";

export const scopeKey = (s: BMQueryScope) => (s.kind === "profile" ? `p${s.profileId}` : s.kind === "run" ? `r${s.runId}` : "org");

export const bmqueryHref = (s: BMQueryScope) =>
  s.kind === "profile" ? `/bmquery?profile=${s.profileId}` : s.kind === "run" ? `/bmquery?run=${s.runId}` : "/bmquery";

export type Preset = { label: string; sql: string };

export function presetQueries(s: BMQueryScope): Preset[] {
  if (s.kind === "run") {
    const w = `run_id = ${s.runId}`;
    return [
      { label: "Leaderboard", sql: `select model, round(accuracy::numeric, 3) as accuracy, round(p50_latency_ms::numeric) as p50_ms,\n       total_cost_usd, cost_per_pass_usd\nfrom model_summary\nwhere ${w}\norder by accuracy desc, total_cost_usd` },
      { label: "Hardest inputs", sql: `select input_file, row_idx, left(prompt, 80) as prompt, count(*) filter (where passed) as models_passed, count(*) as models\nfrom results\nwhere ${w}\ngroup by input_file, row_idx, prompt\norder by models_passed, input_file, row_idx\nlimit 10` },
      { label: "Failures", sql: `select model, input_file, row_idx, expected, left(output, 120) as output, judge_rationale, error\nfrom results\nwhere ${w} and not coalesce(passed, false)\norder by model, input_file, row_idx` },
      { label: "Latency percentiles", sql: `select model,\n       percentile_cont(0.5) within group (order by latency_ms) as p50,\n       percentile_cont(0.9) within group (order by latency_ms) as p90,\n       percentile_cont(0.99) within group (order by latency_ms) as p99\nfrom results\nwhere ${w} and error is null\ngroup by model order by p50` },
      { label: "Accuracy by file", sql: `select input_file, model, count(*) as inputs, round(avg(score)::numeric, 3) as accuracy\nfrom results\nwhere ${w}\ngroup by input_file, model\norder by input_file, accuracy desc` },
      { label: "Reasoning overhead", sql: `select model, sum(reasoning_tokens) as reasoning, sum(tokens_out) as total_out,\n       round(100.0 * sum(reasoning_tokens) / nullif(sum(tokens_out), 0), 1) as reasoning_pct\nfrom results\nwhere ${w}\ngroup by model order by reasoning_pct desc nulls last` },
    ];
  }
  if (s.kind === "profile") {
    const w = `profile_id = ${s.profileId}`;
    return [
      { label: "Versions compared", sql: `select profile_version, prompt_name, count(distinct run_id) as runs, count(distinct model) as models,\n       round(avg(score)::numeric, 3) as accuracy, round(avg(case when passed then 1.0 else 0 end)::numeric, 3) as pass_rate,\n       round(avg(tokens_in)) as avg_tokens_in, round(sum(cost_usd)::numeric, 4) as cost\nfrom results\nwhere ${w}\ngroup by profile_version, prompt_name\norder by profile_version` },
      { label: "Models × versions", sql: `select model, profile_version, round(avg(score)::numeric, 3) as accuracy,\n       round(percentile_cont(0.5) within group (order by latency_ms)::numeric) as p50_ms,\n       round(sum(cost_usd)::numeric, 5) as cost\nfrom results\nwhere ${w}\ngroup by model, profile_version\norder by model, profile_version` },
      { label: "Runs", sql: `select run_id, run_name, profile_version, prompt_name, status, models, input_files, output_file, created_at\nfrom runs\nwhere ${w}\norder by run_id desc` },
      { label: "Inputs that regressed", sql: `select input_file, row_idx, left(prompt, 60) as prompt,\n       round(avg(score) filter (where profile_version = (select min(profile_version) from runs where ${w}))::numeric, 2) as first_version,\n       round(avg(score) filter (where profile_version = (select max(profile_version) from runs where ${w}))::numeric, 2) as latest_version\nfrom results\nwhere ${w}\ngroup by input_file, row_idx, prompt\nhaving avg(score) filter (where profile_version = (select max(profile_version) from runs where ${w}))\n     < avg(score) filter (where profile_version = (select min(profile_version) from runs where ${w}))\norder by input_file, row_idx` },
      { label: "Cost per version", sql: `select profile_version, model, round(sum(cost_usd)::numeric, 5) as cost, sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out\nfrom results\nwhere ${w}\ngroup by profile_version, model\norder by profile_version, cost` },
    ];
  }
  return [
    { label: "Profiles overview", sql: `select profile_id, profile, current_version, versions, runs, updated_at\nfrom profiles\norder by updated_at desc` },
    { label: "Model leaderboard", sql: `select model, count(distinct run_id) as runs, round(avg(score)::numeric, 3) as accuracy,\n       round(percentile_cont(0.5) within group (order by latency_ms)::numeric) as p50_ms,\n       round(sum(cost_usd)::numeric, 4) as total_cost\nfrom results\ngroup by model\norder by accuracy desc, total_cost` },
    { label: "Recent runs", sql: `select run_id, run_name, profile, profile_version, prompt_name, status, models, created_at\nfrom runs\norder by created_at desc\nlimit 20` },
    { label: "Cost by profile", sql: `select coalesce(profile, '(no profile)') as profile, count(distinct run_id) as runs,\n       round(sum(cost_usd)::numeric, 4) as cost, sum(tokens_in + tokens_out) as tokens\nfrom results\ngroup by 1\norder by cost desc` },
    { label: "Prompts compared", sql: `select profile, prompt_name, count(distinct run_id) as runs, round(avg(score)::numeric, 3) as accuracy,\n       round(avg(tokens_in)) as avg_tokens_in\nfrom results\ngroup by profile, prompt_name\norder by profile, accuracy desc` },
  ];
}

export function suggestions(s: BMQueryScope): string[] {
  if (s.kind === "run")
    return ["Which model is the best value, and why?", "Where do the models disagree most?", "Why did the failures happen?", "Is the fastest model also the most accurate?"];
  if (s.kind === "profile")
    return [
      "How did accuracy change across versions, and which version should I keep?",
      "Which inputs got worse in the latest version?",
      "Did the prompt change affect cost or latency?",
      "Which model is most robust to prompt changes?",
    ];
  return [
    "Which model is the best value across all my benchmarks?",
    "Which benchmark profile is hardest for the models?",
    "Where am I spending the most?",
    "Summarize what we've learned so far.",
  ];
}
