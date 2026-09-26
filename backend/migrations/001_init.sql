-- Core schema. Base tables live in `public`; the SQL console only sees the
-- `analytics` views (see bottom), through the read-only `bench_reader` role.

create table models (
    id                   serial primary key,
    provider             text not null,              -- 'vultr' | 'openai_compatible'
    model_id             text not null,              -- id sent to the API
    display_name         text not null,
    base_url             text not null,
    api_key              text,                       -- custom endpoints only; null = provider default
    input_cost_per_mtok  numeric not null default 0, -- USD per 1M prompt tokens
    output_cost_per_mtok numeric not null default 0, -- USD per 1M completion tokens
    context_length       int,
    is_custom            boolean not null default false,
    active               boolean not null default true,
    created_at           timestamptz not null default now(),
    unique (base_url, model_id)
);

create table benchmarks (
    id              serial primary key,
    name            text not null,
    description     text,
    system_prompt   text,
    prompt_template text not null default '{input}',
    scoring_method  text not null,                    -- exact | contains | regex | json_schema | numeric | llm_judge
    scoring_config  jsonb not null default '{}',
    created_at      timestamptz not null default now()
);

create table cases (
    id           serial primary key,
    benchmark_id int not null references benchmarks on delete cascade,
    idx          int not null,
    input        text not null,
    expected     text,
    metadata     jsonb not null default '{}',
    unique (benchmark_id, idx)
);

create table runs (
    id           serial primary key,
    benchmark_id int not null references benchmarks on delete cascade,
    status       text not null default 'queued',     -- queued | running | completed | failed
    params       jsonb not null default '{}',        -- max_tokens, temperature, concurrency
    total_cases  int not null default 0,
    error        text,
    created_at   timestamptz not null default now(),
    started_at   timestamptz,
    finished_at  timestamptz
);

create table run_models (
    run_id   int not null references runs on delete cascade,
    model_id int not null references models,
    primary key (run_id, model_id)
);

-- One row per (run, model, case). Hypertable on created_at.
create table results (
    id               bigserial,
    run_id           int not null references runs on delete cascade,
    case_id          int not null references cases on delete cascade,
    model_id         int not null references models,
    output           text,
    reasoning        text,
    score            double precision,               -- 0..1
    passed           boolean,
    judge_rationale  text,
    latency_ms       double precision,
    ttft_ms          double precision,
    tokens_in        int,
    tokens_out       int,
    reasoning_tokens int,
    tokens_per_sec   double precision,
    cost_usd         numeric(14, 8),
    error            text,
    attempts         int not null default 1,
    created_at       timestamptz not null default now(),
    primary key (id, created_at)
);
select create_hypertable('results', by_range('created_at'));
create index results_run_model_idx on results (run_id, model_id);

create table assistant_messages (
    id         bigserial primary key,
    run_id     int not null references runs on delete cascade,
    role       text not null,                         -- user | assistant | tool
    content    text,
    tool_calls jsonb,
    created_at timestamptz not null default now()
);
create index assistant_messages_run_idx on assistant_messages (run_id, id);

-- ---------------------------------------------------------------------------
-- Analytics views: the only surface the SQL console can see.
-- ---------------------------------------------------------------------------
create schema analytics;

create view analytics.models as
select id as model_pk, provider, model_id, display_name, is_custom,
       input_cost_per_mtok, output_cost_per_mtok, context_length
from models;

create view analytics.benchmarks as
select id as benchmark_id, name, description, scoring_method, created_at
from benchmarks;

create view analytics.cases as
select id as case_id, benchmark_id, idx as case_idx, input, expected
from cases;

create view analytics.runs as
select r.id as run_id, r.benchmark_id, b.name as benchmark, r.status, r.total_cases,
       r.created_at, r.started_at, r.finished_at,
       extract(epoch from (r.finished_at - r.started_at)) as duration_s
from runs r join benchmarks b on b.id = r.benchmark_id;

create view analytics.results as
select r.id as result_id, r.run_id, b.id as benchmark_id, b.name as benchmark,
       m.display_name as model, m.model_id, m.provider,
       c.idx as case_idx, c.input, c.expected, r.output,
       r.score, r.passed, r.judge_rationale,
       r.latency_ms, r.ttft_ms, r.tokens_in, r.tokens_out, r.reasoning_tokens,
       r.tokens_per_sec, r.cost_usd, r.error, r.attempts, r.created_at
from results r
join runs ru      on ru.id = r.run_id
join benchmarks b on b.id = ru.benchmark_id
join models m     on m.id = r.model_id
join cases c      on c.id = r.case_id;

create view analytics.model_summary as
select r.run_id, m.display_name as model, m.model_id, m.provider,
       count(*)                                                        as cases,
       count(*) filter (where r.error is not null)                      as errors,
       avg(r.score)                                                     as accuracy,
       avg(case when r.passed then 1.0 else 0.0 end)                    as pass_rate,
       percentile_cont(0.5)  within group (order by r.latency_ms)       as p50_latency_ms,
       percentile_cont(0.95) within group (order by r.latency_ms)       as p95_latency_ms,
       avg(r.ttft_ms)                                                   as avg_ttft_ms,
       avg(r.tokens_per_sec)                                            as avg_tokens_per_sec,
       sum(r.tokens_in)                                                 as tokens_in,
       sum(r.tokens_out)                                                as tokens_out,
       sum(r.reasoning_tokens)                                          as reasoning_tokens,
       sum(r.cost_usd)                                                  as total_cost_usd,
       sum(r.cost_usd) / nullif(count(*) filter (where r.passed), 0)    as cost_per_pass_usd
from results r join models m on m.id = r.model_id
group by r.run_id, m.display_name, m.model_id, m.provider;

-- ---------------------------------------------------------------------------
-- Read-only role for the SQL console. Password is set by scripts/migrate.py.
-- ---------------------------------------------------------------------------
do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'bench_reader') then
        create role bench_reader nologin;
    end if;
end $$;
grant usage on schema analytics to bench_reader;
grant select on all tables in schema analytics to bench_reader;
alter role bench_reader set search_path = analytics;
alter role bench_reader set statement_timeout = '5s';
alter role bench_reader set default_transaction_read_only = on;
