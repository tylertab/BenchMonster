-- BMQuery: the analyst chat can be scoped to a whole org, one benchmark
-- profile, or one run (previously runs only).

alter table assistant_messages add column org_id int references organizations on delete cascade;
update assistant_messages m set org_id = r.org_id from runs r where r.id = m.run_id;
alter table assistant_messages alter column org_id set not null;
alter table assistant_messages alter column run_id drop not null;
alter table assistant_messages add column profile_id int references benchmark_profiles on delete cascade;
create index assistant_messages_scope_idx on assistant_messages (org_id, profile_id, run_id, id);

-- profile_id on the views (appended so dependent org views stay valid;
-- migrate.py re-provisions org views to pick the column up).
create or replace view analytics.runs as
select r.id as run_id, r.org_id, r.name as run_name, p.name as profile, r.profile_version,
       r.prompt_name, r.template, r.system_prompt, r.scoring_method, r.status,
       (select string_agg(rd.filename, ', ' order by rd.position)
          from run_datasets rd where rd.run_id = r.id)                  as input_files,
       r.output_name                                                    as output_file,
       (select string_agg(m.display_name, ', ' order by m.display_name)
          from run_models rm join models m on m.id = rm.model_id
         where rm.run_id = r.id)                                        as models,
       r.total_inputs, r.created_at, r.started_at, r.finished_at,
       extract(epoch from (r.finished_at - r.started_at))               as duration_s,
       r.profile_id
from runs r left join benchmark_profiles p on p.id = r.profile_id;

create or replace view analytics.results as
select res.id as result_id, r.org_id, res.run_id, r.name as run_name,
       p.name as profile, r.profile_version, r.prompt_name,
       rd.filename as input_file, ri.row_idx, ri.variables, ri.prompt, ri.expected,
       m.display_name as model, m.model_id, m.provider, res.output,
       res.score, res.passed, res.judge_rationale,
       res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out, res.reasoning_tokens,
       res.tokens_per_sec, res.cost_usd, res.error, res.attempts, res.created_at,
       r.profile_id
from results res
join runs r          on r.id = res.run_id
left join benchmark_profiles p on p.id = r.profile_id
join run_inputs ri   on ri.id = res.input_id
join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
join models m        on m.id = res.model_id;

create or replace view analytics.model_summary as
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
       sum(res.cost_usd) / nullif(count(*) filter (where res.passed), 0)  as cost_per_pass_usd,
       r.profile_id
from results res
join models m on m.id = res.model_id
join runs r   on r.id = res.run_id
left join benchmark_profiles p on p.id = r.profile_id
group by r.org_id, res.run_id, r.name, p.name, r.profile_version, r.prompt_name,
         m.display_name, m.model_id, m.provider, r.profile_id;
