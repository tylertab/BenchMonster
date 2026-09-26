"""Which records of a record source a run uses: filter rules, dedupe, then first/random N.

Stored with each record source of a profile version (and copied onto the run), so
a version always selects the same rows from the same data.
"""

import random
import re
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

Op = Literal["eq", "neq", "in", "not_in", "contains", "not_contains", "gt", "gte", "lt", "lte", "empty", "not_empty", "regex"]
NO_VALUE = {"empty", "not_empty"}
MAX_PICK = 10_000


class Rule(BaseModel):
    field: str = Field(min_length=1, max_length=200)
    op: Op
    value: str = Field("", max_length=2000)


class Selection(BaseModel):
    rules: list[Rule] = Field([], max_length=20)
    match: Literal["all", "any"] = "all"  # every rule must match, or at least one
    dedupe_on: str | None = None  # keep the first record per value of this field
    pick: Literal["all", "first", "random"] = "all"
    n: int | None = Field(None, ge=1, le=MAX_PICK)
    seed: int = Field(1, ge=0, le=2**31 - 1)  # random picks are repeatable

    def is_default(self) -> bool:
        return not self.rules and not self.dedupe_on and self.pick == "all"

    def describe(self) -> str:
        parts = []
        if self.rules:
            joiner = " and " if self.match == "all" else " or "
            parts.append("where " + joiner.join(
                f"{r.field} {OP_LABELS[r.op]}" + ("" if r.op in NO_VALUE else f" {r.value!r}") for r in self.rules
            ))
        if self.dedupe_on:
            parts.append(f"one per {self.dedupe_on}")
        if self.pick != "all" and self.n:
            parts.append(f"first {self.n}" if self.pick == "first" else f"random {self.n} (seed {self.seed})")
        return ", ".join(parts)


OP_LABELS = {
    "eq": "=", "neq": "≠", "in": "is one of", "not_in": "is not one of", "contains": "contains",
    "not_contains": "doesn't contain", "gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "empty": "is empty",
    "not_empty": "is not empty", "regex": "matches",
}


def _num(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _list(value: str) -> set[str]:
    return {v.strip().lower() for v in value.split(",") if v.strip()}


def _compare(cell: str, rule: Rule) -> int | None:
    """Sign of cell - value: numeric when both are numbers, else text (case-insensitive)."""
    a, b = _num(cell), _num(rule.value)
    if a is not None and b is not None:
        return (a > b) - (a < b)
    if a is not None or b is not None:
        return None  # a number against text never satisfies > or <
    x, y = cell.lower(), rule.value.strip().lower()
    return (x > y) - (x < y)


def _matcher(rule: Rule):
    op, value = rule.op, rule.value.strip()
    if op == "regex":
        try:
            pattern = re.compile(rule.value)
        except re.error as e:
            raise HTTPException(400, f"filter on {rule.field}: invalid regular expression ({e})")
        return lambda cell: pattern.search(cell) is not None
    if op in ("in", "not_in"):
        options = _list(rule.value)
        return (lambda cell: cell.strip().lower() in options) if op == "in" else (lambda cell: cell.strip().lower() not in options)
    if op == "empty":
        return lambda cell: not cell.strip()
    if op == "not_empty":
        return lambda cell: bool(cell.strip())
    if op in ("contains", "not_contains"):
        needle = value.lower()
        return (lambda cell: needle in cell.lower()) if op == "contains" else (lambda cell: needle not in cell.lower())
    if op in ("eq", "neq"):
        def eq(cell: str) -> bool:
            c = _compare(cell.strip(), rule)
            return c == 0
        return eq if op == "eq" else (lambda cell: not eq(cell))
    want = {"gt": (1,), "gte": (0, 1), "lt": (-1,), "lte": (-1, 0)}[op]
    return lambda cell: (c := _compare(cell.strip(), rule)) is not None and c in want


def validate(sel: Selection, columns: list[str], label: str) -> None:
    cols = set(columns)
    for r in sel.rules:
        if r.field not in cols:
            raise HTTPException(400, f"{label}: filter field {r.field!r} is not in the file")
        if r.op not in NO_VALUE and not r.value.strip() and r.op not in ("eq", "neq"):
            raise HTTPException(400, f"{label}: filter on {r.field} needs a value")
    if sel.dedupe_on and sel.dedupe_on not in cols:
        raise HTTPException(400, f"{label}: dedupe field {sel.dedupe_on!r} is not in the file")
    if sel.pick != "all" and not sel.n:
        raise HTTPException(400, f"{label}: say how many records to pick")


class Stats(BaseModel):
    total: int
    matched: int  # after filter rules
    unique: int  # after dedupe
    selected: int  # after first/random N


def apply(rows: list, sel: Selection) -> tuple[list[tuple[int, object]], Stats]:
    """rows: records in file order, each with a .data / ["data"] dict of strings.

    Returns (original position, row) pairs in file order, plus counts per step.
    Positions stay the original ones so expected outputs matched by record
    order still line up after filtering.
    """
    indexed = list(enumerate(rows))
    if sel.rules:
        checks = [(r.field, _matcher(r)) for r in sel.rules]
        combine = all if sel.match == "all" else any
        indexed = [(i, r) for i, r in indexed if combine(check(str(r["data"].get(f, "") or "")) for f, check in checks)]
    matched = len(indexed)
    if sel.dedupe_on:
        seen, unique = set(), []
        for i, r in indexed:
            key = str(r["data"].get(sel.dedupe_on, "") or "").strip()
            if key not in seen:
                seen.add(key)
                unique.append((i, r))
        indexed = unique
    unique_count = len(indexed)
    if sel.pick == "first" and sel.n:
        indexed = indexed[: sel.n]
    elif sel.pick == "random" and sel.n and sel.n < len(indexed):
        picked = set(random.Random(sel.seed).sample(range(len(indexed)), sel.n))
        indexed = [x for k, x in enumerate(indexed) if k in picked]
    return indexed, Stats(total=len(rows), matched=matched, unique=unique_count, selected=len(indexed))
