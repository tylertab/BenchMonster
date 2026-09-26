-- Saved query names are unique per org regardless of case ("Leaderboard" = "leaderboard").
-- Resolve any existing case-only duplicates by suffixing the newer ones.
update saved_queries q set name = q.name || ' (' || q.id || ')'
where exists (
    select 1 from saved_queries o
    where o.org_id = q.org_id and lower(o.name) = lower(q.name) and o.id < q.id
);
alter table saved_queries drop constraint saved_queries_org_id_name_key;
create unique index saved_queries_org_name_ci on saved_queries (org_id, lower(name));
