-- Benchmark profiles: a named, versioned run configuration.
--
-- A profile version holds everything a run needs: prompt (name, system prompt,
-- template), input sets (datasets + variable mapping + expected column), output
-- expectations (scoring), models, and params. Versions are immutable; editing
-- creates version N+1. Runs point at (profile_id, profile_version) and still
-- keep their own snapshot + rendered inputs.

create table benchmark_profiles (
    id              serial primary key,
    org_id          int not null references organizations on delete cascade,
    name            text not null,
    description     text,
    current_version int,
    created_by      int references users on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    legacy_key      text
);
create index benchmark_profiles_org_idx on benchmark_profiles (org_id, updated_at desc);

create table profile_versions (
    id             serial primary key,
    profile_id     int not null references benchmark_profiles on delete cascade,
    version        int not null,
    prompt_name    text not null,
    system_prompt  text,
    template       text not null,
    scoring_method text not null,
    scoring_config jsonb not null default '{}',
    model_ids      int[] not null,
    params         jsonb not null default '{}',
    note           text,                          -- change note
    created_by     int references users on delete set null,
    created_at     timestamptz not null default now(),
    legacy_run_id  int,
    unique (profile_id, version)
);

create table profile_version_datasets (
    version_id      int not null references profile_versions on delete cascade,
    position        int not null,
    dataset_id      int references datasets on delete set null,
    dataset_name    text not null,
    filename        text not null,
    mapping         jsonb not null,
    expected_column text,
    primary key (version_id, position)
);

alter table runs
    add column profile_id      int references benchmark_profiles on delete set null,
    add column profile_version int;
create index runs_profile_idx on runs (profile_id, profile_version);

-- ---------------------------------------------------------------------------
-- Import existing runs: one profile per (org, prompt), one version per run.
-- ---------------------------------------------------------------------------
insert into benchmark_profiles (org_id, name, created_by, created_at, legacy_key)
select distinct on (org_id, coalesce(prompt_id::text, prompt_name))
       org_id, prompt_name, created_by, created_at,
       org_id || ':' || coalesce(prompt_id::text, prompt_name)
from runs
order by org_id, coalesce(prompt_id::text, prompt_name), created_at;

insert into profile_versions (profile_id, version, prompt_name, system_prompt, template, scoring_method,
                              scoring_config, model_ids, params, note, created_by, created_at, legacy_run_id)
select p.id,
       row_number() over (partition by p.id order by r.created_at, r.id),
       r.prompt_name, r.system_prompt, r.template, r.scoring_method, r.scoring_config,
       array(select rm.model_id from run_models rm where rm.run_id = r.id order by rm.model_id),
       r.params, 'Imported from run ' || r.id, r.created_by, r.created_at, r.id
from runs r
join benchmark_profiles p on p.legacy_key = r.org_id || ':' || coalesce(r.prompt_id::text, r.prompt_name);

insert into profile_version_datasets (version_id, position, dataset_id, dataset_name, filename, mapping, expected_column)
select v.id, rd.position, rd.dataset_id, rd.dataset_name, rd.filename, rd.mapping, rd.expected_column
from profile_versions v join run_datasets rd on rd.run_id = v.legacy_run_id;

update runs r set profile_id = v.profile_id, profile_version = v.version
from profile_versions v where v.legacy_run_id = r.id;

update benchmark_profiles p
set current_version = (select max(version) from profile_versions v where v.profile_id = p.id),
    updated_at = coalesce((select max(created_at) from profile_versions v where v.profile_id = p.id), p.created_at);

alter table benchmark_profiles drop column legacy_key;
alter table profile_versions drop column legacy_run_id;

-- ---------------------------------------------------------------------------
-- Analytics views gain profile/version and run name.
-- ---------------------------------------------------------------------------
drop schema analytics cascade;
create schema analytics;

create view analytics.models as
select id as model_pk, org_id, provider, model_id, display_name, is_custom,
       input_cost_per_mtok, output_cost_per_mtok, context_length
from models;

create view analytics.prompts as
select id as prompt_id, org_id, name, system_prompt, template, created_at, updated_at
from prompts;

create view analytics.datasets as
select id as dataset_id, org_id, name, filename, format, columns, row_count, created_at
from datasets;

create view analytics.profiles as
select p.id as profile_id, p.org_id, p.name as profile, p.description, p.current_version,
       (select count(*) from profile_versions v where v.profile_id = p.id) as versions,
       (select count(*) from runs r where r.profile_id = p.id)            as runs,
       p.created_at, p.updated_at
from benchmark_profiles p;

create view analytics.profile_versions as
select v.profile_id, p.org_id, p.name as profile, v.version, v.note, v.prompt_name, v.system_prompt, v.template,
       v.scoring_method, v.scoring_config, v.params,
       (select string_agg(d.filename, ', ' order by d.position)
          from profile_version_datasets d where d.version_id = v.id)          as input_files,
       (select string_agg(m.display_name, ', ' order by m.display_name)
          from models m where m.id = any(v.model_ids))                         as models,
       v.created_at
from profile_versions v join benchmark_profiles p on p.id = v.profile_id;

create view analytics.runs as
select r.id as run_id, r.org_id, r.name as run_name, p.name as profile, r.profile_version,
       r.prompt_name, r.template, r.system_prompt, r.scoring_method, r.status,
       (select string_agg(rd.filename, ', ' order by rd.position)
          from run_datasets rd where rd.run_id = r.id)                  as input_files,
       r.output_name                                                    as output_file,
       (select string_agg(m.display_name, ', ' order by m.display_name)
          from run_models rm join models m on m.id = rm.model_id
         where rm.run_id = r.id)                                        as models,
       r.total_inputs, r.created_at, r.started_at, r.finished_at,
       extract(epoch from (r.finished_at - r.started_at))               as duration_s
from runs r left join benchmark_profiles p on p.id = r.profile_id;

create view analytics.inputs as
select ri.id as input_id, r.org_id, ri.run_id, rd.filename as input_file, ri.row_idx,
       ri.variables, ri.prompt, ri.expected
from run_inputs ri
join runs r          on r.id = ri.run_id
join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position;

create view analytics.results as
select res.id as result_id, r.org_id, res.run_id, r.name as run_name,
       p.name as profile, r.profile_version, r.prompt_name,
       rd.filename as input_file, ri.row_idx, ri.variables, ri.prompt, ri.expected,
       m.display_name as model, m.model_id, m.provider, res.output,
       res.score, res.passed, res.judge_rationale,
       res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out, res.reasoning_tokens,
       res.tokens_per_sec, res.cost_usd, res.error, res.attempts, res.created_at
from results res
join runs r          on r.id = res.run_id
left join benchmark_profiles p on p.id = r.profile_id
join run_inputs ri   on ri.id = res.input_id
join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
join models m        on m.id = res.model_id;

create view analytics.model_summary as
select r.org_id, res.run_id, r.name as run_name, p.name as profile, r.profile_version, r.prompt_name,
       m.display_name as model, m.model_id, m.provider,
       count(*)                                                          as cases,
       count(*) filter (where res.error is not null)                      as errors,
       avg(res.score)                                                     as accuracy,
       avg(case when res.passed then 1.0 else 0.0 end)                    as pass_rate,
       percentile_cont(0.5)  within group (order by res.latency_ms)       as p50_latency_ms,
       percentile_cont(0.95) within group (order by res.latency_ms)       as p95_latency_ms,
       avg(res.ttft_ms)                                                   as avg_ttft_ms,
       avg(res.tokens_per_sec)                                            as avg_tokens_per_sec,
       sum(res.tokens_in)                                                 as tokens_in,
       sum(res.tokens_out)                                                as tokens_out,
       sum(res.reasoning_tokens)                                          as reasoning_tokens,
       sum(res.cost_usd)                                                  as total_cost_usd,
       sum(res.cost_usd) / nullif(count(*) filter (where res.passed), 0)  as cost_per_pass_usd
from results res
join models m on m.id = res.model_id
join runs r   on r.id = res.run_id
left join benchmark_profiles p on p.id = r.profile_id
group by r.org_id, res.run_id, r.name, p.name, r.profile_version, r.prompt_name,
         m.display_name, m.model_id, m.provider;
