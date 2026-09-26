-- Accounts, organizations, and org-scoped data.
--
-- Every benchmark (and so every run/result) and every custom model belongs to an
-- organization. The SQL console no longer uses one shared reader: each org gets
-- its own schema `org_<id>` of pre-filtered views and its own login role
-- `org_<id>_reader` (provisioned by app/orgs.py), so user SQL physically cannot
-- see another org's rows.

create table users (
    id            serial primary key,
    email         text not null,
    name          text not null,
    password_hash text not null,
    created_at    timestamptz not null default now()
);
create unique index users_email_idx on users (lower(email));

create table organizations (
    id                     serial primary key,
    name                   text not null,
    backboard_assistant_id text,          -- org-level analyst memory (created lazily)
    reader_password        text,          -- login for org_<id>_reader
    created_at             timestamptz not null default now()
);

create table memberships (
    org_id     int not null references organizations on delete cascade,
    user_id    int not null references users on delete cascade,
    role       text not null check (role in ('owner', 'admin')),
    created_at timestamptz not null default now(),
    primary key (org_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

create table invitations (
    id          serial primary key,
    org_id      int not null references organizations on delete cascade,
    email       text not null,
    role        text not null check (role in ('owner', 'admin')),
    token_hash  text not null unique,
    invited_by  int references users on delete set null,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null,
    accepted_at timestamptz
);

create table sessions (
    token_hash text primary key,              -- sha256 of the cookie value
    user_id    int not null references users on delete cascade,
    org_id     int references organizations on delete set null,  -- active org
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table saved_queries (
    id         serial primary key,
    org_id     int not null references organizations on delete cascade,
    name       text not null,
    sql        text not null,
    created_by int references users on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (org_id, name)
);

-- Existing data moves into a "Demo" org.
insert into organizations (name) values ('Demo');

alter table benchmarks add column org_id int references organizations on delete cascade;
update benchmarks set org_id = (select min(id) from organizations);
alter table benchmarks alter column org_id set not null;
create index benchmarks_org_idx on benchmarks (org_id);

-- models.org_id: null = global catalog (Vultr), set = an org's custom endpoint.
alter table models add column org_id int references organizations on delete cascade;
update models set org_id = (select min(id) from organizations) where is_custom;
alter table models drop constraint models_base_url_model_id_key;
create unique index models_scope_uniq on models (coalesce(org_id, 0), base_url, model_id);

-- ---------------------------------------------------------------------------
-- Analytics views gain org_id. They are the source for each org's views and
-- are not granted to any reader role directly.
-- ---------------------------------------------------------------------------
drop schema analytics cascade;
create schema analytics;

create view analytics.models as
select id as model_pk, org_id, provider, model_id, display_name, is_custom,
       input_cost_per_mtok, output_cost_per_mtok, context_length
from models;

create view analytics.benchmarks as
select id as benchmark_id, org_id, name, description, scoring_method, created_at
from benchmarks;

create view analytics.cases as
select c.id as case_id, b.org_id, c.benchmark_id, c.idx as case_idx, c.input, c.expected
from cases c join benchmarks b on b.id = c.benchmark_id;

create view analytics.runs as
select r.id as run_id, b.org_id, r.benchmark_id, b.name as benchmark, r.status, r.total_cases,
       r.created_at, r.started_at, r.finished_at,
       extract(epoch from (r.finished_at - r.started_at)) as duration_s
from runs r join benchmarks b on b.id = r.benchmark_id;

create view analytics.results as
select r.id as result_id, b.org_id, r.run_id, b.id as benchmark_id, b.name as benchmark,
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
select b.org_id, r.run_id, m.display_name as model, m.model_id, m.provider,
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
from results r
join models m     on m.id = r.model_id
join runs ru      on ru.id = r.run_id
join benchmarks b on b.id = ru.benchmark_id
group by b.org_id, r.run_id, m.display_name, m.model_id, m.provider;

-- The old shared reader could see every org; retire it.
alter role bench_reader nologin;
