-- Prompts and datasets become first-class; a run = one prompt + one or more
-- datasets. Replaces benchmarks/cases.
--
-- A run snapshots everything it used (template, system prompt, scoring,
-- dataset names, column mapping) and stores every rendered input, so editing
-- or deleting a prompt/dataset later never changes a past run.

create table prompts (
    id            serial primary key,
    org_id        int not null references organizations on delete cascade,
    name          text not null,
    system_prompt text,
    template      text not null,                  -- uses {{variable}} placeholders
    created_by    int references users on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    legacy_benchmark_id int
);
create index prompts_org_idx on prompts (org_id, updated_at desc);

create table datasets (
    id         serial primary key,
    org_id     int not null references organizations on delete cascade,
    name       text not null,
    filename   text not null,
    format     text not null,                     -- csv | jsonl | json
    columns    text[] not null,
    row_count  int not null,
    created_by int references users on delete set null,
    created_at timestamptz not null default now(),
    legacy_benchmark_id int
);
create index datasets_org_idx on datasets (org_id, created_at desc);

create table dataset_rows (
    dataset_id int not null references datasets on delete cascade,
    idx        int not null,
    data       jsonb not null,                    -- {column: string value}
    primary key (dataset_id, idx)
);

alter table runs
    add column org_id         int references organizations on delete cascade,
    add column name           text,
    add column prompt_id      int references prompts on delete set null,
    add column prompt_name    text,
    add column system_prompt  text,
    add column template       text,
    add column scoring_method text,
    add column scoring_config jsonb not null default '{}',
    add column output_name    text,               -- predictions file name
    add column created_by     int references users on delete set null;
alter table runs rename column total_cases to total_inputs;

create table run_datasets (
    run_id          int not null references runs on delete cascade,
    position        int not null,
    dataset_id      int references datasets on delete set null,
    dataset_name    text not null,
    filename        text not null,
    mapping         jsonb not null,               -- {template variable: dataset column}
    expected_column text,
    primary key (run_id, position)
);

create table run_inputs (
    id               serial primary key,
    run_id           int not null references runs on delete cascade,
    dataset_position int not null,
    row_idx          int not null,
    variables        jsonb not null,              -- {variable: value} used to render
    prompt           text not null,               -- rendered user message
    expected         text,
    legacy_case_id   int,
    unique (run_id, dataset_position, row_idx)
);

-- ---------------------------------------------------------------------------
-- Migrate each benchmark -> prompt + dataset, and each run onto them.
-- ---------------------------------------------------------------------------
insert into prompts (org_id, name, system_prompt, template, created_at, legacy_benchmark_id)
select org_id, name, system_prompt, replace(prompt_template, '{input}', '{{input}}'), created_at, id
from benchmarks;

insert into datasets (org_id, name, filename, format, columns, row_count, created_at, legacy_benchmark_id)
select b.org_id, b.name,
       trim(both '-' from lower(regexp_replace(b.name, '\W+', '-', 'g'))) || '.csv',
       'csv', array['input', 'expected'],
       (select count(*) from cases c where c.benchmark_id = b.id), b.created_at, b.id
from benchmarks b;

insert into dataset_rows (dataset_id, idx, data)
select d.id, c.idx, jsonb_build_object('input', c.input, 'expected', coalesce(c.expected, ''))
from cases c join datasets d on d.legacy_benchmark_id = c.benchmark_id;

update runs r
set org_id = b.org_id, prompt_id = p.id, prompt_name = p.name, system_prompt = p.system_prompt,
    template = p.template, scoring_method = b.scoring_method, scoring_config = b.scoring_config,
    output_name = 'run-' || r.id || '-predictions.csv'
from benchmarks b join prompts p on p.legacy_benchmark_id = b.id
where b.id = r.benchmark_id;

insert into run_datasets (run_id, position, dataset_id, dataset_name, filename, mapping, expected_column)
select r.id, 0, d.id, d.name, d.filename, '{"input": "input"}', 'expected'
from runs r join datasets d on d.legacy_benchmark_id = r.benchmark_id;

insert into run_inputs (run_id, dataset_position, row_idx, variables, prompt, expected, legacy_case_id)
select r.id, 0, c.idx, jsonb_build_object('input', c.input),
       replace(b.prompt_template, '{input}', c.input), c.expected, c.id
from runs r join benchmarks b on b.id = r.benchmark_id join cases c on c.benchmark_id = b.id;

-- Views depend on cases/benchmarks; org_<id> views cascade too and are
-- re-provisioned by migrate.py.
drop schema analytics cascade;

alter table results add column input_id int references run_inputs on delete cascade;
update results res set input_id = ri.id
from run_inputs ri where ri.run_id = res.run_id and ri.legacy_case_id = res.case_id;
alter table results alter column input_id set not null;
alter table results drop column case_id;

alter table runs alter column org_id set not null;
alter table runs alter column template set not null;
alter table runs alter column scoring_method set not null;
alter table runs alter column output_name set not null;
alter table runs drop column benchmark_id;
create index runs_org_created_idx on runs (org_id, created_at desc);

drop table cases;
drop table benchmarks;
alter table prompts drop column legacy_benchmark_id;
alter table datasets drop column legacy_benchmark_id;
alter table run_inputs drop column legacy_case_id;

-- ---------------------------------------------------------------------------
-- Analytics views (source for each org's org_<id> views).
-- ---------------------------------------------------------------------------
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

create view analytics.runs as
select r.id as run_id, r.org_id, r.name, r.prompt_name, r.template, r.system_prompt,
       r.scoring_method, r.status,
       (select string_agg(rd.filename, ', ' order by rd.position)
          from run_datasets rd where rd.run_id = r.id)                  as input_files,
       r.output_name                                                    as output_file,
       (select string_agg(m.display_name, ', ' order by m.display_name)
          from run_models rm join models m on m.id = rm.model_id
         where rm.run_id = r.id)                                        as models,
       r.total_inputs, r.created_at, r.started_at, r.finished_at,
       extract(epoch from (r.finished_at - r.started_at))               as duration_s
from runs r;

create view analytics.inputs as
select ri.id as input_id, r.org_id, ri.run_id, rd.filename as input_file, ri.row_idx,
       ri.variables, ri.prompt, ri.expected
from run_inputs ri
join runs r          on r.id = ri.run_id
join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position;

create view analytics.results as
select res.id as result_id, r.org_id, res.run_id, r.prompt_name,
       rd.filename as input_file, ri.row_idx, ri.variables, ri.prompt, ri.expected,
       m.display_name as model, m.model_id, m.provider, res.output,
       res.score, res.passed, res.judge_rationale,
       res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out, res.reasoning_tokens,
       res.tokens_per_sec, res.cost_usd, res.error, res.attempts, res.created_at
from results res
join runs r          on r.id = res.run_id
join run_inputs ri   on ri.id = res.input_id
join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
join models m        on m.id = res.model_id;

create view analytics.model_summary as
select r.org_id, res.run_id, m.display_name as model, m.model_id, m.provider,
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
group by r.org_id, res.run_id, m.display_name, m.model_id, m.provider;
