-- Which records of a record source a run uses: filter rules, dedupe, and
-- first/random N ({"rules": [...], "match": "all", "dedupe_on": ..., "pick": ..., "n": ..., "seed": ...}).
-- Empty = every record.
alter table profile_version_datasets add column selection jsonb not null default '{}';
alter table run_datasets add column selection jsonb not null default '{}';
