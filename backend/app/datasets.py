"""Parse uploaded datasets (CSV, JSONL, JSON array) into rows of strings."""

import csv
import io
import json

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
