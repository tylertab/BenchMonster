-- The value actually compared with the expected output, after the profile's
-- output processing (e.g. a JSON field or regex capture pulled from the raw reply).
alter table results add column processed_output text;

create or replace view analytics.results as
select res.id as result_id, r.org_id, res.run_id, r.name as run_name,
       p.name as profile, r.profile_version, r.prompt_name,
       rd.filename as input_file, ri.row_idx, ri.variables, ri.prompt, ri.expected,
       m.display_name as model, m.model_id, m.provider, res.output,
       res.score, res.passed, res.judge_rationale,
       res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out, res.reasoning_tokens,
       res.tokens_per_sec, res.cost_usd, res.error, res.attempts, res.created_at,
       r.profile_id,
       rd.expected_filename as expected_file,
       coalesce(r.params->>'mode', 'realtime') as mode,
       res.batch_no,
       res.processed_output
from results res
join runs r          on r.id = res.run_id
left join benchmark_profiles p on p.id = r.profile_id
join run_inputs ri   on ri.id = res.input_id
join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
join models m        on m.id = res.model_id;
