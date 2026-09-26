"""Copy a finished run's results to a connection: JSONL + summary files in object
storage, or rows in Postgres tables (re-exporting a run replaces its rows)."""

import json
import logging
import re
from datetime import datetime, timezone

from fastapi import HTTPException

from . import connections as conns
from . import db, linked

log = logging.getLogger(__name__)

# Postgres export tables: <prefix>_results (one row per input x model) and
# <prefix>_model_summary (one row per model).
RESULT_COLUMNS = {
    "run_id": "int", "run_name": "text", "profile": "text", "profile_version": "int", "model": "text",
    "model_id": "text", "input_file": "text", "row_idx": "int", "variables": "jsonb", "prompt": "text",
    "expected": "text", "output": "text", "processed_output": "text", "score": "double precision",
    "passed": "boolean", "judge_rationale": "text", "latency_ms": "double precision", "ttft_ms": "double precision",
    "tokens_in": "int", "tokens_out": "int", "reasoning_tokens": "int", "cost_usd": "double precision",
    "error": "text", "exported_at": "timestamptz",
}
SUMMARY_COLUMNS = {
    "run_id": "int", "run_name": "text", "profile": "text", "profile_version": "int", "model": "text",
    "model_id": "text", "cases": "int", "errors": "int", "accuracy": "double precision",
    "pass_rate": "double precision", "p50_latency_ms": "double precision", "p95_latency_ms": "double precision",
    "avg_ttft_ms": "double precision", "tokens_in": "bigint", "tokens_out": "bigint",
    "total_cost_usd": "double precision", "cost_per_pass_usd": "double precision", "exported_at": "timestamptz",
}


def default_target(kind: str) -> str:
    return "benchmonster/runs" if kind == "s3" else "benchmonster"


def _clean_target(kind: str, target: str | None) -> str:
    target = (target or "").strip().strip("/") or default_target(kind)
    if kind == "postgres" and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,40}", target):
        raise HTTPException(400, "table prefix: letters, digits and _ only (e.g. benchmonster)")
    if kind == "s3" and ".." in target.split("/"):
        raise HTTPException(400, "invalid folder")
    return target


def _num(v):
    return float(v) if v is not None else None


async def _gather(run_id: int) -> tuple[dict, list[dict], list[dict]]:
    pool = db.pool()
    run = await pool.fetchrow(
        """select r.id, r.name, r.status, r.prompt_name, r.template, r.scoring_method, r.params, r.total_inputs,
                  r.created_at, r.finished_at, r.profile_version, p.name as profile
           from runs r left join benchmark_profiles p on p.id = r.profile_id where r.id = $1""",
        run_id,
    )
    results = await pool.fetch(
        """select rd.filename as input_file, ri.row_idx, ri.variables, ri.prompt, ri.expected, m.display_name as model,
                  m.model_id, res.output, res.processed_output, res.score, res.passed, res.judge_rationale,
                  res.latency_ms, res.ttft_ms, res.tokens_in, res.tokens_out, res.reasoning_tokens, res.cost_usd, res.error
           from results res
           join run_inputs ri on ri.id = res.input_id
           join run_datasets rd on rd.run_id = ri.run_id and rd.position = ri.dataset_position
           join models m on m.id = res.model_id
           where res.run_id = $1
           order by ri.dataset_position, ri.row_idx, m.display_name""",
        run_id,
    )
    summary = await pool.fetch(
        """select model, model_id, cases, errors, accuracy, pass_rate, p50_latency_ms, p95_latency_ms, avg_ttft_ms,
                  tokens_in, tokens_out, total_cost_usd, cost_per_pass_usd
           from analytics.model_summary where run_id = $1 order by accuracy desc nulls last, total_cost_usd""",
        run_id,
    )
    return dict(run), [dict(r) for r in results], [dict(s) for s in summary]


async def _write(org_id: int, run_id: int, connection_id: int, target: str | None) -> tuple[str, str, str, int]:
    """Returns (connection name, target, detail, rows)."""
    conn, cfg, sec = await linked.load_connection(org_id, connection_id)
    if not conn["allow_write"]:
        raise HTTPException(400, f"{conn['name']} is read-only; edit the connection to allow writes")
    target = _clean_target(conn["kind"], target)
    run, results, summary = await _gather(run_id)
    now = datetime.now(timezone.utc)
    meta = {"run_id": run["id"], "run_name": run["name"], "profile": run["profile"], "profile_version": run["profile_version"]}
    if conn["kind"] == "s3":
        folder = f"{target}/{run_id}"
        lines = "\n".join(json.dumps({**meta, **{k: _num(v) if k == "cost_usd" else v for k, v in r.items()}}, ensure_ascii=False, default=str) for r in results)
        doc = {
            **meta, "status": run["status"], "prompt_name": run["prompt_name"], "scoring_method": run["scoring_method"],
            "params": run["params"], "inputs": run["total_inputs"], "created_at": run["created_at"],
            "finished_at": run["finished_at"], "exported_at": now, "template": run["template"],
            "models": [{k: _num(v) if k in ("pass_rate", "total_cost_usd", "cost_per_pass_usd") else v for k, v in s.items()} for s in summary],
        }
        await conns.s3_write(cfg, sec, f"{folder}/results.jsonl", (lines + "\n").encode(), "application/x-ndjson")
        await conns.s3_write(cfg, sec, f"{folder}/summary.json", json.dumps(doc, indent=2, default=str).encode(), "application/json")
        return conn["name"], folder, f"wrote {folder}/results.jsonl ({len(results)} rows) and summary.json", len(results)

    result_rows = [
        tuple({**meta, **r, "variables": json.dumps(r["variables"], ensure_ascii=False), "cost_usd": _num(r["cost_usd"]),
               "exported_at": now}[c] for c in RESULT_COLUMNS)
        for r in results
    ]
    summary_rows = [
        tuple({**meta, **s, "pass_rate": _num(s["pass_rate"]), "total_cost_usd": _num(s["total_cost_usd"]),
               "cost_per_pass_usd": _num(s["cost_per_pass_usd"]), "exported_at": now}[c] for c in SUMMARY_COLUMNS)
        for s in summary
    ]
    await conns.pg_write(cfg, sec, [(f"{target}_results", RESULT_COLUMNS, result_rows),
                                    (f"{target}_model_summary", SUMMARY_COLUMNS, summary_rows)], replace_run_id=run_id)
    schema = cfg.schema_
    return conn["name"], f"{schema}.{target}_*", f"wrote {len(result_rows)} rows to {schema}.{target}_results and {len(summary_rows)} to {schema}.{target}_model_summary", len(result_rows)


async def export_run(org_id: int, run_id: int, connection_id: int, target: str | None, *, user_id: int | None,
                     automatic: bool = False) -> dict:
    """Export and record the attempt (failed attempts are recorded too, then re-raised)."""
    status = await db.pool().fetchval("select status from runs where id = $1 and org_id = $2", run_id, org_id)
    if status is None:
        raise HTTPException(404, "run not found")
    if status in ("queued", "running"):
        raise HTTPException(409, "wait for the run to finish before exporting it")
    name = await db.pool().fetchval("select name from connections where id = $1 and org_id = $2", connection_id, org_id)
    try:
        name, where, detail, rows = await _write(org_id, run_id, connection_id, target)
        ok, error = True, None
    except HTTPException as e:
        where, detail, rows, ok, error = (target or "").strip() or "(default)", e.detail, None, False, e
    export_id = await db.pool().fetchval(
        """insert into run_exports (run_id, connection_id, connection_name, target, status, detail, rows, automatic, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id""",
        run_id, connection_id if name else None, name or "(deleted connection)", where, "ok" if ok else "failed",
        detail, rows, automatic, user_id,
    )
    if error:
        raise error
    return {"id": export_id, "target": where, "detail": detail, "rows": rows}


async def auto_export(run_id: int) -> None:
    """After a run finishes: export it if its profile is set to. Never fails the run."""
    row = await db.pool().fetchrow(
        """select r.org_id, p.export_connection_id, p.export_target from runs r
           join benchmark_profiles p on p.id = r.profile_id where r.id = $1 and p.export_connection_id is not null""",
        run_id,
    )
    if not row:
        return
    try:
        await export_run(row["org_id"], run_id, row["export_connection_id"], row["export_target"], user_id=None, automatic=True)
    except HTTPException as e:
        log.warning("auto-export of run %s failed: %s", run_id, e.detail)
    except Exception:
        log.exception("auto-export of run %s failed", run_id)
