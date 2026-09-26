-- Record sources read straight from a connection's table (streamed in chunks
-- during the run, never copied): {"connection_id": N, "table": "schema.table", "key": "id"}.
-- And which columns reach the prompt and how they're parsed:
-- [{"column": "Age", "name": "age", "parse": "integer", "decimals": null}, ...]; null = every column, auto.
alter table profile_version_datasets
    add column source jsonb,
    add column fields jsonb,
    alter column dataset_name drop not null;
alter table run_datasets
    add column source jsonb,
    add column fields jsonb;

-- Streamed runs: where the run is ({"max_key": ..., "last_key": ..., "done": N}) so a
-- restart resumes instead of failing. Their inputs keep the record key, not the prompt.
alter table runs add column stream_state jsonb;
alter table run_inputs alter column prompt drop not null;
