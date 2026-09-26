"""Datasets imported from a connection: fetching the source and refreshing the copy.

A linked dataset is still a stored copy (runs need stable rows and reproducible
prompts); "refresh" re-reads the source, and auto_refresh does it before each run.
"""

from datetime import datetime, timezone

from fastapi import HTTPException

from . import connections as conns
from . import dataset_store, datasets, db, selection


async def load_connection(org_id: int, connection_id: int):
    row = await db.pool().fetchrow(
        "select id, name, kind, config, secret, allow_write from connections where id = $1 and org_id = $2",
        connection_id, org_id,
    )
    if not row:
        raise HTTPException(404, "connection not found (deleted?)")
    cfg, sec = conns.parse_config(row["kind"], row["config"], conns.decrypt(row["secret"]))
    return row, cfg, sec


async def fetch(org_id: int, source: dict) -> tuple[str, str, list[str] | None, list[dict[str, str]], str | None]:
    """Read a source: (filename, format, columns or None, rows, etag or None)."""
    conn, cfg, sec = await load_connection(org_id, source["connection_id"])
    if conn["kind"] == "s3":
        path = source.get("path") or ""
        body, etag = await conns.s3_read(cfg, sec, path)
        filename = path.rsplit("/", 1)[-1]
        try:
            rows = datasets.parse(filename, body)
        except (datasets.DatasetError, ValueError) as e:
            raise HTTPException(400, f"{path}: {e}")
        fmt = filename.rsplit(".", 1)[-1].lower()
        return filename, "jsonl" if fmt == "ndjson" else fmt, None, rows, etag
    rules = [selection.Rule(**r) for r in source.get("rules") or []]
    columns, rows = await conns.pg_read(cfg, sec, table=source.get("table"), query=source.get("query"),
                                        rules=rules, match=source.get("match") or "all")
    return source.get("table") or "query", "table" if source.get("table") else "sql", columns, rows, None


async def import_dataset(org_id: int, user_id: int, source: dict, name: str | None, description: str | None) -> int:
    filename, fmt, columns, rows, etag = await fetch(org_id, source)
    stored = {**source, "etag": etag, "synced_at": datetime.now(timezone.utc).isoformat()}
    return await dataset_store.create(
        org_id, user_id, name=(name or "").strip() or filename.rsplit(".", 1)[0], filename=filename, fmt=fmt,
        rows=rows, description=description, source=stored, columns=columns,
    )


async def refresh(org_id: int, dataset_id: int) -> dict:
    """Re-read a linked dataset's source. Skips files whose ETag hasn't changed."""
    ds = await db.pool().fetchrow("select id, filename, source from datasets where id = $1 and org_id = $2", dataset_id, org_id)
    if not ds:
        raise HTTPException(404, "dataset not found")
    source = ds["source"]
    if not source:
        raise HTTPException(400, f"{ds['filename']} was uploaded, not imported from a connection")
    if source.get("etag") and source.get("path"):
        conn, cfg, sec = await load_connection(org_id, source["connection_id"])
        if conn["kind"] == "s3" and await conns.s3_etag(cfg, sec, source["path"]) == source["etag"]:
            await db.pool().execute(
                "update datasets set source = source || jsonb_build_object('synced_at', $2::text) where id = $1",
                dataset_id, datetime.now(timezone.utc).isoformat(),
            )
            return {"changed": False}
    _, _, columns, rows, etag = await fetch(org_id, source)
    await dataset_store.replace_rows(
        dataset_id, rows, {**source, "etag": etag, "synced_at": datetime.now(timezone.utc).isoformat()}, columns
    )
    return {"changed": True, "row_count": len(rows)}


async def refresh_for_run(org_id: int, dataset_ids: set[int]) -> None:
    """Refresh the datasets a run reads that are set to refresh before every run."""
    if not dataset_ids:
        return
    rows = await db.pool().fetch(
        "select id, filename from datasets where id = any($1) and org_id = $2 and (source->>'auto_refresh')::boolean",
        list(dataset_ids), org_id,
    )
    for r in rows:
        try:
            await refresh(org_id, r["id"])
        except HTTPException as e:
            raise HTTPException(400, f"couldn't refresh {r['filename']} from its connection: {e.detail}")
