-- Expose each run's execution settings to BMQuery: realtime vs batch, batch
-- size, max tokens, temperature, concurrency (all in runs.params), whether its
-- records were streamed from a connection's table, and the library prompt version.
-- Views can only gain columns at the end.
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
       r.profile_id,
       coalesce(r.params->>'mode', 'realtime')                          as mode,
       case when r.params->>'mode' = 'batch' then (r.params->>'batch_size')::int end as batch_size,
       (r.params->>'max_tokens')::int                                   as max_tokens,
       (r.params->>'temperature')::float                                as temperature,
       (r.params->>'concurrency')::int                                  as concurrency,
       r.params,
       (r.stream_state is not null)                                     as streamed,
       r.prompt_version
from runs r left join benchmark_profiles p on p.id = r.profile_id;

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
       r.profile_id,
       coalesce(r.params->>'mode', 'realtime')                            as mode
from results res
join models m on m.id = res.model_id
join runs r   on r.id = res.run_id
left join benchmark_profiles p on p.id = r.profile_id
group by r.org_id, res.run_id, r.name, p.name, r.profile_version, r.prompt_name, m.display_name, m.model_id,
         m.provider, r.profile_id, coalesce(r.params->>'mode', 'realtime');
