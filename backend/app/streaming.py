"""Run a profile whose record source is a connection's table, without copying it.

Rows are read in key order, one chunk at a time (the next chunk is fetched while
the current one is being answered), rendered into prompts in memory, sent to
every model, and scored. Only the record key, the expected value and the
results are stored. After each chunk the run saves how far it got, so a server
restart resumes the run instead of failing it.
"""

import asyncio
import logging

from . import connections as conns
from . import db, linked, runconfig, runner, templates
from . import fields as field_lib

log = logging.getLogger("uvicorn.error")


async def execute(run, models, params) -> None:
    pool = db.pool()
    run_id = run["id"]
    rd = await pool.fetchrow("select * from run_datasets where run_id = $1 order by position limit 1", run_id)
    source = rd["source"]
    _, pcfg, psec = await linked.load_connection(run["org_id"], source["connection_id"])
    spec = runconfig.stream_spec(source, rd["selection"])
    info = await conns.pg_table_info(pcfg, psec, source["table"])
    columns = {c["name"]: c["type"] for c in info["columns"]}

    variables = templates.variables(run["template"])
    bindings = {v: runconfig.Binding(**b) for v, b in (run["bindings"] or {}).items() if v in variables}
    constants, _ = await runconfig._resolve_bindings(run["org_id"], bindings)
    mapping = rd["mapping"]
    specs = [field_lib.FieldSpec(**f) for f in rd["fields"]] if rd["fields"] is not None else None
    renderer = field_lib.RowRenderer(specs, list(columns), None)
    key, expected_column = source["key"], rd["expected_column"]

    state = dict(run["stream_state"])
    done = state.get("done", 0)
    # A restart can leave a half-finished chunk: drop it and redo it.
    await pool.execute("delete from run_inputs where run_id = $1 and row_idx >= $2", run_id, done)

    sems = {m["id"]: asyncio.Semaphore(params["concurrency"]) for m in models}
    size = params["batch_size"]
    batch_no = done // size
    rows_iter = conns.pg_stream(pcfg, psec, spec, columns, state["max_key"], state.get("last_key"), skip=done)
    pending = asyncio.ensure_future(anext(rows_iter, None))
    try:
        while True:
            rows = await pending
            if not rows:
                break
            pending = asyncio.ensure_future(anext(rows_iter, None))  # read ahead while this chunk runs

            prepared = []
            for i, row in enumerate(rows, start=done):
                values = {v: renderer.record(row) if c == runconfig.RECORD else renderer.value(row, c) for v, c in mapping.items()}
                expected = (row.get(expected_column) or None) if expected_column else None
                prepared.append((i, {key: row[key]}, templates.render(run["template"], {**constants, **values}), expected))
            await pool.executemany(
                """insert into run_inputs (run_id, dataset_position, row_idx, variables, prompt, expected)
                   values ($1, 0, $2, $3, null, $4)""",
                [(run_id, i, v, e) for i, v, _, e in prepared],
            )
            ids = {r["row_idx"]: r["id"] for r in await pool.fetch(
                "select id, row_idx from run_inputs where run_id = $1 and row_idx >= $2 and row_idx < $3",
                run_id, done, done + len(rows),
            )}
            inputs = [{"id": ids[i], "prompt": p, "expected": e} for i, _, p, e in prepared]

            jobs = []
            for model in models:
                if params["mode"] == "batch":
                    for k in range(0, len(inputs), size):
                        jobs.append(runner._run_batch(run_id, run, model, batch_no + k // size, inputs[k:k + size], params, sems[model["id"]]))
                else:
                    jobs += [runner._run_input(run_id, run, model, inp, params, sems[model["id"]]) for inp in inputs]
            await asyncio.gather(*jobs)

            done += len(rows)
            batch_no += -(-len(rows) // size)
            state.update(done=done, last_key=rows[-1][key])
            await pool.execute("update runs set stream_state = $2 where id = $1", run_id, state)
    finally:
        pending.cancel()
        await rows_iter.aclose()
    if done < run["total_inputs"]:
        # Rows deleted from the table mid-run: finish with what was there.
        await pool.execute("update runs set total_inputs = $2 where id = $1", run_id, done)
