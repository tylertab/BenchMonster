-- Prompt library versioning: every change to a prompt's text is a new,
-- immutable version; prompts keeps the current text for listing.
create table prompt_versions (
    id            serial primary key,
    prompt_id     int not null references prompts on delete cascade,
    version       int not null,
    system_prompt text,
    template      text not null,
    note          text,
    created_by    int references users on delete set null,
    created_at    timestamptz not null default now(),
    unique (prompt_id, version)
);
alter table prompts add column current_version int not null default 1;
insert into prompt_versions (prompt_id, version, system_prompt, template, created_by, created_at)
select id, 1, system_prompt, template, created_by, created_at from prompts;

-- Which library prompt version a profile version / run was built from (if any).
alter table profile_versions
    add column prompt_id      int references prompts on delete set null,
    add column prompt_version int;
alter table runs add column prompt_version int;
