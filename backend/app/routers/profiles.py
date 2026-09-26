"""Benchmark profiles: named, versioned run configurations.

Every edit of the configuration creates a new immutable version; restoring an
old version copies it forward as the newest version. Runs start from a
specific version (the current one by default).
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import auth, db, runconfig, templates

router = APIRouter(prefix="/api/profiles", tags=["profiles"])

SECTIONS = ("prompt", "inputs", "scoring", "models", "params")


# --- helpers ------------------------------------------------------------------


async def _profile(profile_id: int, org_id: int):
    row = await db.pool().fetchrow(
        """select p.*, u.name as created_by_name from benchmark_profiles p
           left join users u on u.id = p.created_by where p.id = $1 and p.org_id = $2""",
        profile_id, org_id,
    )
    if not row:
        raise HTTPException(404, "benchmark profile not found")
    return row


async def _version(profile_id: int, version: int) -> dict:
    v = await db.pool().fetchrow(
        """select v.*, u.name as created_by_name from profile_versions v
           left join users u on u.id = v.created_by where v.profile_id = $1 and v.version = $2""",
        profile_id, version,
    )
    if not v:
        raise HTTPException(404, f"version {version} not found")
    datasets = await db.pool().fetch(
        """select d.position, d.dataset_id, d.dataset_name, d.filename, d.mapping, d.expected_column,
                  d.expected_dataset_id, d.expected_filename, d.input_key, d.expected_key, d.selection,
                  d.source, d.fields, ds.row_count, ds.columns, ds.format, (ds.id is not null or d.source is not null) as available,
                  eds.row_count as expected_row_count, eds.columns as expected_columns, eds.format as expected_format,
                  (d.expected_dataset_id is null or eds.id is not null) as expected_available
           from profile_version_datasets d
           left join datasets ds on ds.id = d.dataset_id
           left join datasets eds on eds.id = d.expected_dataset_id
           where d.version_id = $1 order by d.position""",
        v["id"],
    )
    models = await db.pool().fetch(
        "select id, display_name, model_id, active from models where id = any($1) order by display_name", v["model_ids"]
    )
    out = {k: v[k] for k in ("version", "prompt_name", "system_prompt", "template", "scoring_method",
                             "scoring_config", "model_ids", "params", "note", "created_at", "created_by_name",
                             "bindings", "expected_text")}
    out["display_bindings"] = await runconfig.with_filenames(v["bindings"])
    return {**out, "variables": templates.variables(v["template"]),
            "datasets": [dict(d) for d in datasets], "models": [dict(m) for m in models]}


def _as_config(v: dict) -> runconfig.RunConfig:
    return runconfig.RunConfig(
        prompt_name=v["prompt_name"], system_prompt=v["system_prompt"], template=v["template"],
        datasets=[runconfig.DatasetRef(dataset_id=d["dataset_id"] or (None if d["source"] else 0), mapping=d["mapping"],
                                       source=d["source"], fields=d["fields"],
                                       expected_column=d["expected_column"],
                                       expected_dataset_id=d["expected_dataset_id"], input_key=d["input_key"],
                                       expected_key=d["expected_key"], selection=d["selection"] or {})
                  for d in v["datasets"]],
        bindings=v["bindings"] or {}, expected_text=v["expected_text"],
        scoring_method=v["scoring_method"], scoring_config=v["scoring_config"], model_ids=v["model_ids"],
        **{k: v["params"][k] for k in ("max_tokens", "temperature", "concurrency", "mode", "batch_size") if k in v["params"]},
    )


def _sections(cfg: runconfig.RunConfig) -> dict:
    """Comparable view of each config section, for change detection."""
    variables = templates.variables(cfg.template)
    bindings = {k: b for k, b in cfg.bindings_json().items() if k in variables}
    record_vars = [v for v in variables if v not in bindings]
    return {
        "prompt": (cfg.prompt_name.strip(), (cfg.system_prompt or "").strip(), cfg.template),
        # Unmapped variables default to same-named columns, so compare resolved mappings.
        "inputs": (
            [(d.dataset_id, sorted({v: d.mapping.get(v) or v for v in record_vars}.items()),
              d.expected_column or None, d.expected_dataset_id, d.input_key or None, d.expected_key or None,
              d.selection.model_dump(exclude_defaults=True),
              d.source.model_dump() if d.source else None,
              [f.model_dump(exclude_defaults=True) for f in d.fields] if d.fields is not None else None)
             for d in cfg.datasets],
            sorted((k, json.dumps(b, sort_keys=True)) for k, b in bindings.items()),
        ),
        "scoring": (cfg.scoring_method, cfg.scoring_config, (cfg.expected_text or "").strip() or None),
        "models": sorted(set(cfg.model_ids)),
        "params": cfg.params(),
    }


def _changed(a: runconfig.RunConfig, b: runconfig.RunConfig) -> list[str]:
    sa, sb = _sections(a), _sections(b)
    return [s for s in SECTIONS if sa[s] != sb[s]]


async def _insert_version(conn, profile_id: int, cfg: runconfig.RunConfig, datasets: list[tuple], note: str | None,
                          user_id: int) -> int:
    version = await conn.fetchval(
        "select coalesce(max(version), 0) + 1 from profile_versions where profile_id = $1", profile_id
    )
    version_id = await conn.fetchval(
        """insert into profile_versions (profile_id, version, prompt_name, system_prompt, template, scoring_method,
               scoring_config, model_ids, params, note, created_by, bindings, expected_text)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id""",
        profile_id, version, cfg.prompt_name.strip(), (cfg.system_prompt or "").strip() or None, cfg.template,
        cfg.scoring_method, cfg.scoring_config, sorted(set(cfg.model_ids)), cfg.params(),
        (note or "").strip() or None, user_id, cfg.bindings_json(), (cfg.expected_text or "").strip() or None,
    )
    await conn.executemany(
        """insert into profile_version_datasets (version_id, position, dataset_id, dataset_name, filename, mapping,
               expected_column, expected_dataset_id, expected_filename, input_key, expected_key, selection, source, fields)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)""",
        [(version_id, *d) for d in datasets],
    )
    await conn.execute(
        "update benchmark_profiles set current_version = $2, updated_at = now() where id = $1", profile_id, version
    )
    return version


# --- profiles ------------------------------------------------------------------


@router.get("")
async def list_profiles(ctx: auth.Ctx = Depends(auth.current_ctx)):
    rows = await db.pool().fetch(
        """select p.id, p.name, p.description, p.current_version, p.created_at, p.updated_at,
                  u.name as created_by,
                  (select count(*) from runs r where r.profile_id = p.id) as run_count,
                  (select max(r.created_at) from runs r where r.profile_id = p.id) as last_run_at,
                  v.prompt_name, v.scoring_method,
                  (select coalesce(json_agg(d.filename order by d.position), '[]')
                     from profile_version_datasets d where d.version_id = v.id) as input_files,
                  cardinality(v.model_ids) as model_count,
                  (select max(s.accuracy) from analytics.model_summary s
                    where s.run_id = (select max(r.id) from runs r where r.profile_id = p.id
                                      and r.profile_version = p.current_version and r.status = 'completed')
                  ) as current_best_accuracy
           from benchmark_profiles p
           left join profile_versions v on v.profile_id = p.id and v.version = p.current_version
           left join users u on u.id = p.created_by
           where p.org_id = $1 order by p.updated_at desc""",
        ctx.org_id,
    )
    return [dict(r) for r in rows]


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)
    config: runconfig.RunConfig
    note: str | None = Field(None, max_length=500)


@router.post("")
async def create_profile(body: ProfileIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    prepared = await runconfig.prepare(ctx.org_id, body.config, render=False)
    async with db.pool().acquire() as conn, conn.transaction():
        profile_id = await conn.fetchval(
            "insert into benchmark_profiles (org_id, name, description, created_by) values ($1, $2, $3, $4) returning id",
            ctx.org_id, body.name.strip(), (body.description or "").strip() or None, ctx.user_id,
        )
        await _insert_version(conn, profile_id, body.config, prepared.datasets, body.note or "Created", ctx.user_id)
    return await get_profile(profile_id, ctx)


@router.get("/{profile_id}")
async def get_profile(profile_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Profile metadata, its current version's full config, and version history with change summaries."""
    p = await _profile(profile_id, ctx.org_id)
    rows = await db.pool().fetch(
        """select v.version, v.note, v.created_at, u.name as created_by,
                  (select count(*) from runs r where r.profile_id = v.profile_id and r.profile_version = v.version) as run_count
           from profile_versions v left join users u on u.id = v.created_by
           where v.profile_id = $1 order by v.version desc""",
        profile_id,
    )
    # Summarize what each version changed relative to the one before it.
    configs = {}
    for r in rows:
        configs[r["version"]] = _as_config(await _version(profile_id, r["version"]))
    versions = []
    for r in rows:
        prev = configs.get(r["version"] - 1)
        versions.append({**dict(r), "changed": _changed(prev, configs[r["version"]]) if prev else []})
    return {
        "id": p["id"], "name": p["name"], "description": p["description"],
        "current_version": p["current_version"], "created_at": p["created_at"], "updated_at": p["updated_at"],
        "created_by": p["created_by_name"],
        "export_connection_id": p["export_connection_id"], "export_target": p["export_target"],
        "current": await _version(profile_id, p["current_version"]),
        "versions": versions,
    }


class ProfileMetaIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)


@router.patch("/{profile_id}")
async def rename_profile(profile_id: int, body: ProfileMetaIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Name and description aren't versioned."""
    await _profile(profile_id, ctx.org_id)
    await db.pool().execute(
        "update benchmark_profiles set name = $2, description = $3, updated_at = now() where id = $1",
        profile_id, body.name.strip(), (body.description or "").strip() or None,
    )
    return {"ok": True}


class DuplicateIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    version: int | None = None  # default: current version


@router.post("/{profile_id}/duplicate")
async def duplicate_profile(profile_id: int, body: DuplicateIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Copy a profile version into a new profile (v1), e.g. to make a US and an EU variant."""
    p = await _profile(profile_id, ctx.org_id)
    version = body.version or p["current_version"]
    cfg = _as_config(await _version(profile_id, version))
    prepared = await runconfig.prepare(ctx.org_id, cfg, render=False)
    async with db.pool().acquire() as conn, conn.transaction():
        new_id = await conn.fetchval(
            "insert into benchmark_profiles (org_id, name, description, created_by) values ($1, $2, $3, $4) returning id",
            ctx.org_id, (body.name or "").strip() or f"{p['name']} (copy)", p["description"], ctx.user_id,
        )
        await _insert_version(conn, new_id, cfg, prepared.datasets, f"Duplicated from {p['name']} v{version}", ctx.user_id)
    return await get_profile(new_id, ctx)


@router.delete("/{profile_id}")
async def delete_profile(profile_id: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Runs are kept (they have their own snapshot); they just lose the profile link."""
    await _profile(profile_id, ctx.org_id)
    await db.pool().execute("delete from benchmark_profiles where id = $1", profile_id)
    return {"ok": True}


# --- versions ------------------------------------------------------------------


@router.get("/{profile_id}/versions/{version}")
async def get_version(profile_id: int, version: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    await _profile(profile_id, ctx.org_id)
    return await _version(profile_id, version)


class VersionIn(BaseModel):
    config: runconfig.RunConfig
    note: str | None = Field(None, max_length=500)


@router.post("/{profile_id}/versions")
async def save_version(profile_id: int, body: VersionIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Save an edited configuration as the next version (refused if nothing changed)."""
    p = await _profile(profile_id, ctx.org_id)
    current = _as_config(await _version(profile_id, p["current_version"]))
    changed = _changed(current, body.config)
    if not changed:
        raise HTTPException(400, "nothing changed since the current version")
    prepared = await runconfig.prepare(ctx.org_id, body.config, render=False)
    async with db.pool().acquire() as conn, conn.transaction():
        version = await _insert_version(conn, profile_id, body.config, prepared.datasets, body.note, ctx.user_id)
    return {"version": version, "changed": changed}


@router.post("/{profile_id}/versions/{version}/restore")
async def restore_version(profile_id: int, version: int, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Copy an old version forward as the newest version (history stays linear)."""
    p = await _profile(profile_id, ctx.org_id)
    if version == p["current_version"]:
        raise HTTPException(400, f"v{version} is already the current version")
    cfg = _as_config(await _version(profile_id, version))
    prepared = await runconfig.prepare(ctx.org_id, cfg, render=False)
    async with db.pool().acquire() as conn, conn.transaction():
        new = await _insert_version(conn, profile_id, cfg, prepared.datasets, f"Restored from v{version}", ctx.user_id)
    return {"version": new}


# --- runs --------------------------------------------------------------------


class ProfileRunIn(BaseModel):
    version: int | None = None  # default: current version
    name: str | None = Field(None, max_length=200)
    output_name: str | None = Field(None, max_length=200)


@router.post("/{profile_id}/runs")
async def run_profile(profile_id: int, body: ProfileRunIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    p = await _profile(profile_id, ctx.org_id)
    version = body.version or p["current_version"]
    cfg = _as_config(await _version(profile_id, version))
    run_id = await runconfig.create_run(
        ctx.org_id, ctx.user_id, cfg, name=body.name, output=body.output_name,
        profile_id=profile_id, profile_version=version, label=f"{p['name']} v{version}",
    )
    return {"id": run_id, "version": version}


class ExportSettingsIn(BaseModel):
    connection_id: int | None = None  # None = don't export automatically
    target: str | None = Field(None, max_length=300)


@router.put("/{profile_id}/export")
async def set_auto_export(profile_id: int, body: ExportSettingsIn, ctx: auth.Ctx = Depends(auth.current_ctx)):
    """Export every finished run of this profile to a connection (or stop)."""
    await _profile(profile_id, ctx.org_id)
    if body.connection_id is not None:
        c = await db.pool().fetchrow(
            "select allow_write, access from connections where id = $1 and org_id = $2", body.connection_id, ctx.org_id
        )
        if c is None:
            raise HTTPException(404, "connection not found")
        if not c["allow_write"]:
            raise HTTPException(400, "that connection is read-only; edit it to allow writes")
        if (c["access"] or {}).get("write") is False:
            raise HTTPException(400, "that connection's credentials can't write (see its last access check)")
    await db.pool().execute(
        "update benchmark_profiles set export_connection_id = $2, export_target = $3 where id = $1",
        profile_id, body.connection_id, ((body.target or "").strip() or None) if body.connection_id else None,
    )
    return {"export_connection_id": body.connection_id, "export_target": (body.target or "").strip() or None}
