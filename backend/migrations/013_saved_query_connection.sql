-- A saved query can target a Postgres connection instead of BenchMonster's own data.
alter table saved_queries add column connection_id int references connections on delete cascade;
