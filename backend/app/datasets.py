"""Parse uploaded datasets (CSV, JSONL, JSON array) into rows of strings."""

import csv
import io
import json

import jsonschema

MAX_ROWS = 5000
INPUT_GUESSES = ("input", "prompt", "question", "query", "text", "instruction")
EXPECTED_GUESSES = ("expected", "expected_output", "answer", "output", "target", "label", "reference")


class DatasetError(ValueError):
    pass


def _stringify(v) -> str:
    if v is None:
        return ""
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def parse(filename: str, data: bytes) -> list[dict[str, str]]:
    text = data.decode("utf-8-sig")
    name = filename.lower()
    if name.endswith(".csv"):
        rows = list(csv.DictReader(io.StringIO(text)))
    elif name.endswith((".jsonl", ".ndjson")):
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    elif name.endswith(".json"):
        loaded = json.loads(text)
        rows = loaded if isinstance(loaded, list) else loaded.get("data") or loaded.get("rows") or []
    else:
        raise DatasetError("Upload a .csv, .jsonl, or .json file")
    if not rows or not all(isinstance(r, dict) for r in rows):
        raise DatasetError("Dataset must be a non-empty list of objects/rows")
    if len(rows) > MAX_ROWS:
        raise DatasetError(f"Dataset has {len(rows)} rows; the limit is {MAX_ROWS}")
    return [{str(k): _stringify(v) for k, v in r.items()} for r in rows]


def guess_column(columns: list[str], guesses: tuple[str, ...]) -> str | None:
    lower = {c.lower(): c for c in columns}
    return next((lower[g] for g in guesses if g in lower), None)


# --- Row schemas ---------------------------------------------------------------
# Rows are stored as strings (CSV has no types; JSON values are serialized), so
# schemas describe what each string holds, and validation coerces before checking.

_TRUE, _FALSE = {"true", "True", "TRUE"}, {"false", "False", "FALSE"}


def _kind(value: str) -> str | None:
    s = value.strip()
    if not s:
        return None
    if s in _TRUE or s in _FALSE:
        return "boolean"
    try:
        int(s)
        return "integer"
    except ValueError:
        pass
    try:
        float(s)
        return "number"
    except ValueError:
        pass
    if s[0] in "{[":
        try:
            return "object" if isinstance(json.loads(s), dict) else "array"
        except json.JSONDecodeError:
            pass
    return "string"


def infer_schema(rows: list[dict[str, str]], columns: list[str]) -> dict:
    """JSON Schema for one row, from up to 1,000 rows of string values."""
    sample = rows[:1000]
    props = {}
    for c in columns:
        kinds = {k for r in sample if (k := _kind(r.get(c, "")))}
        if not kinds:
            t = "string"
        elif kinds <= {"integer"}:
            t = "integer"
        elif kinds <= {"integer", "number"}:
            t = "number"
        elif len(kinds) == 1:
            t = kinds.pop()
        else:
            t = "string"
        props[c] = {"type": t}
    required = [c for c in columns if all(r.get(c, "") != "" for r in rows)]
    return {"type": "object", "properties": props, "required": required}


def _coerce(value: str, typ):
    t = typ[0] if isinstance(typ, list) else typ
    s = value.strip()
    try:
        if t == "integer":
            return int(s)
        if t == "number":
            return float(s)
        if t == "boolean":
            return True if s in _TRUE else False if s in _FALSE else value
        if t in ("object", "array"):
            return json.loads(s)
    except (ValueError, json.JSONDecodeError):
        return value  # leave it; validation will report the type mismatch
    return value


def validate_rows(rows: list[tuple[int, dict]], schema: dict) -> dict:
    """Check every row against the schema. Empty strings count as missing values."""
    validator = jsonschema.Draft202012Validator(schema)
    props = schema.get("properties") or {}
    invalid, errors = 0, []
    for idx, row in rows:
        obj = {
            k: _coerce(v, props[k].get("type")) if k in props and "type" in props[k] else v
            for k, v in row.items()
            if v != "" or (props.get(k, {}).get("type") == "string")
        }
        errs = list(validator.iter_errors(obj))
        if errs:
            invalid += 1
            if len(errors) < 10:
                path = "/".join(str(p) for p in errs[0].absolute_path) or "(row)"
                errors.append({"row": idx, "field": path, "message": errs[0].message[:200]})
    return {"checked": len(rows), "invalid": invalid, "errors": errors}


def typed_row(row: dict[str, str], schema: dict | None, drop: tuple[str, ...] = (), order: list[str] | None = None) -> dict:
    """A row as typed JSON (per the schema), e.g. "true" -> true, in the file's column order."""
    props = (schema or {}).get("properties") or {}
    keys = [k for k in (order or []) if k in row] + [k for k in row if k not in (order or [])]
    out = {}
    for k in keys:
        v = row[k]
        if k in drop:
            continue
        t = props.get(k, {}).get("type")
        out[k] = _coerce(v, t) if t and v != "" else (None if v == "" and t and t != "string" else v)
    return out
