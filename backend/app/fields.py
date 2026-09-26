"""Which columns of a record source reach the prompt, under what name, parsed how.

Record values arrive as text (uploaded files) or are converted to text (database
rows). A field spec parses each chosen column into a typed value: that value is
what `{{field}}` variables print and what the whole-record JSON contains.
"""

import json
import math
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

ParseAs = Literal["auto", "text", "integer", "number", "boolean", "json"]
TRUE = {"true", "t", "yes", "y", "1"}
FALSE = {"false", "f", "no", "n", "0"}


class FieldSpec(BaseModel):
    column: str = Field(min_length=1, max_length=200)
    name: str | None = Field(None, max_length=200)  # key in the record JSON (default: the column)
    parse: ParseAs = "auto"
    decimals: int | None = Field(None, ge=0, le=10)  # numbers: round to this many places

    @property
    def key(self) -> str:
        return (self.name or "").strip() or self.column


def validate(fields: list[FieldSpec] | None, columns: list[str], label: str) -> None:
    if fields is None:
        return
    if not fields:
        raise HTTPException(400, f"{label}: choose at least one field")
    cols = set(columns)
    keys = set()
    for f in fields:
        if f.column not in cols:
            raise HTTPException(400, f"{label}: field {f.column!r} is not in the source")
        if f.key in keys:
            raise HTTPException(400, f"{label}: two fields are named {f.key!r}")
        keys.add(f.key)


def _auto(raw: str, typ: str | None):
    """Typed by the column's schema type if known, else by what the text looks like."""
    if typ in ("integer", "number", "boolean", "object", "array"):
        parse = {"integer": "integer", "number": "number", "boolean": "boolean"}.get(typ, "json")
        return parse_value(raw, FieldSpec(column="_", parse=parse))
    if typ == "string":
        return raw
    s = raw.strip()
    if s in ("true", "false"):
        return s == "true"
    try:
        n = float(s)
        if math.isfinite(n):
            return int(n) if n.is_integer() and "." not in s and "e" not in s.lower() else n
    except ValueError:
        pass
    return raw


def parse_value(raw: str | None, spec: FieldSpec, typ: str | None = None):
    """The typed value, or the raw text if it doesn't parse (a run never fails on one bad cell)."""
    if raw is None:
        return None
    s = raw.strip()
    if spec.parse == "text":
        return raw
    if spec.parse != "auto" and s == "":
        return None
    try:
        if spec.parse == "auto":
            v = _auto(raw, typ)
        elif spec.parse == "integer":
            v = int(float(s))
        elif spec.parse == "number":
            v = float(s)
        elif spec.parse == "boolean":
            low = s.lower()
            if low not in TRUE | FALSE:
                return raw
            v = low in TRUE
        else:
            v = json.loads(s)
    except (ValueError, json.JSONDecodeError):
        return raw
    if isinstance(v, float) and spec.decimals is not None:
        v = round(v, spec.decimals)
        if spec.decimals == 0:
            v = int(v)
    return v


def as_text(value, spec: FieldSpec) -> str:
    """How a parsed value prints in the prompt for a {{field}} variable."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and spec.decimals is not None:
        return f"{value:.{spec.decimals}f}"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


class RowRenderer:
    """Values for a record's variables: {{field}} columns and the whole-record JSON."""

    def __init__(self, fields: list[FieldSpec] | None, columns: list[str], schema: dict | None):
        self.specs = fields if fields is not None else [FieldSpec(column=c) for c in columns]
        self.by_column = {f.column: f for f in self.specs}
        props = (schema or {}).get("properties") or {}
        self.types = {c: props.get(c, {}).get("type") if isinstance(props.get(c, {}).get("type"), str) else None for c in columns}

    def value(self, row: dict, column: str) -> str:
        spec = self.by_column.get(column) or FieldSpec(column=column)
        raw = row.get(column)
        return as_text(parse_value(raw if raw is None else str(raw), spec, self.types.get(column)), spec)

    def record(self, row: dict) -> str:
        return json.dumps(
            {f.key: parse_value(None if row.get(f.column) is None else str(row.get(f.column)), f, self.types.get(f.column)) for f in self.specs},
            ensure_ascii=False,
        )
