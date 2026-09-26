-- Connections to an org's own cloud storage / databases, used to import
-- datasets and (when allowed) to export results.
create table connections (
    id          serial primary key,
    org_id      int not null references organizations on delete cascade,
    name        text not null,
    kind        text not null check (kind in ('s3', 'postgres')),
    provider    text not null default 'other',   -- vultr | tiger | aws | other (a preset label)
    config      jsonb not null,                  -- endpoint, bucket, host, database... (no secrets)
    secret      bytea not null,                  -- credentials, Fernet-encrypted JSON
    allow_write boolean not null default false,  -- the org lets BenchMonster write here
    access      jsonb,                           -- last access check: {read, write, detail, checked_at}
    created_by  int references users on delete set null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create unique index connections_org_name_idx on connections (org_id, lower(name));

-- Where an imported dataset came from, so it can be refreshed:
-- {"connection_id": N, "path": "folder/file.csv"} or {"connection_id": N, "table": "schema.table", "rules": [...]}
-- or {"connection_id": N, "query": "select ..."}, plus "etag", "synced_at", "auto_refresh".
alter table datasets add column source jsonb;
