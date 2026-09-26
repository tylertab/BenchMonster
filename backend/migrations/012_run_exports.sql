-- Run results copied to a connection (object storage files or Postgres tables).
create table run_exports (
    id              serial primary key,
    run_id          int not null references runs on delete cascade,
    connection_id   int references connections on delete set null,
    connection_name text not null,
    target          text not null,               -- folder in the bucket, or schema.table prefix
    status          text not null check (status in ('ok', 'failed')),
    detail          text,
    rows            int,
    automatic       boolean not null default false,
    created_by      int references users on delete set null,
    created_at      timestamptz not null default now()
);
create index run_exports_run_idx on run_exports (run_id, created_at desc);

-- A profile can export every finished run to a connection automatically.
alter table benchmark_profiles
    add column export_connection_id int references connections on delete set null,
    add column export_target        text;
