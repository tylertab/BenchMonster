-- Expected outputs from their own dataset, dataset metadata + row schemas,
-- and batched-prompting runs.

-- Datasets: description and a JSON Schema for one row (inferred on upload, editable).
alter table datasets add column description text, add column schema jsonb;

-- An input set's expected outputs can come from a separate dataset, matched to
-- input rows by key columns (input_key <-> expected_key) or, if no keys, by row order.
-- expected_column: the column holding the expected value (in the expected dataset,
-- or in the input file when expected_dataset_id is null). With an expected dataset
-- and no column, the expected value is the whole row (minus the key) as JSON.
alter table profile_version_datasets
    add column expected_dataset_id int references datasets on delete set null,
    add column expected_filename   text,
    add column input_key           text,
    add column expected_key        text;

alter table run_datasets
    add column expected_dataset_id int references datasets on delete set null,
    add column expected_filename   text,
    add column input_key           text,
    add column expected_key        text;

-- Batched prompting: which packed request an item was answered in.
alter table results add column batch_no int;

-- Views (append-only changes so dependent org views stay valid).
create or replace view analytics.datasets as
select id as dataset_id, org_id, name, filename, format, columns, row_count, created_at,
       description, schema
from datasets;

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
       res.batch_no
from results res
join runs r          on r.id = res.run_id
left join benchmark_profiles p on p.id = r.profile_id
join run_inputs ri   on ri.id = res.input_id
join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
join models m        on m.id = res.model_id;
