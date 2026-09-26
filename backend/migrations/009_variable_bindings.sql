-- Variables that don't come from the per-record data: fixed text or a whole
-- dataset inlined into the prompt. {variable: {"type": "text", "value": ...} |
-- {"type": "dataset", "dataset_id": N, "format": "json"|"jsonl"|"csv"}}.
-- With no per-record variables a run is a single prompt per model, optionally
-- compared with a fixed expected_text.
alter table profile_versions
    add column bindings      jsonb not null default '{}',
    add column expected_text text;

alter table runs
    add column bindings      jsonb not null default '{}',
    add column expected_text text;

-- Single-prompt runs have no input dataset.
alter table run_datasets alter column dataset_name drop not null;
