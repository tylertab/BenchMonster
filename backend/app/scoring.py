"""Turn (input, expected, output) into a 0..1 score.

Methods (benchmark.scoring_method) and their scoring_config keys:
  exact        case_sensitive (false)
  contains     case_sensitive (false)
  regex        pattern (defaults to the case's expected value)
  numeric      tolerance (abs, default 1e-6), rel_tolerance (default 0)
  json_schema  schema (required), match_expected (false): also require equality with expected JSON
  json_fields  fields (default: every key in expected), schema (optional), pass_threshold (1.0):
               score = fraction of fields whose value matches the expected JSON
  llm_judge    rubric (optional), pass_threshold (0.7)
"""

import json
import re
import string
from dataclasses import dataclass

import jsonschema

from . import providers
from .config import settings

METHODS = ("exact", "contains", "regex", "numeric", "json_schema", "json_fields", "llm_judge")

_NUMBER = re.compile(r"-?\d[\d,]*\.?\d*(?:[eE][-+]?\d+)?")
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


@dataclass
class Score:
    score: float
    passed: bool
    rationale: str | None = None


def _normalize(s: str, case_sensitive: bool) -> str:
    s = " ".join(s.strip().split()).strip(string.punctuation + " ")
    return s if case_sensitive else s.casefold()


def _parse_json(text: str):
    text = _FENCE.sub("", text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Fall back to the first {...} or [...] block in the text.
        m = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
        if m:
            return json.loads(m.group(1))
        raise


def _last_number(text: str) -> float | None:
    nums = _NUMBER.findall(text)
    return float(nums[-1].replace(",", "")) if nums else None


_MISSING = object()


def _get(data, path: str):
    """Dotted-path lookup: 'customer.tier' -> data['customer']['tier']."""
    for part in path.split("."):
        if not isinstance(data, dict) or part not in data:
            return _MISSING
        data = data[part]
    return data


def _norm(v):
    if isinstance(v, str):
        return " ".join(v.split()).casefold()
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, list):
        # Order-insensitive: tags/labels lists rarely have meaningful order.
        return sorted((_norm(x) for x in v), key=repr)
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    return v


def _binary(ok: bool, why: str | None = None) -> Score:
    return Score(1.0 if ok else 0.0, ok, why)


def score_rule_based(method: str, cfg: dict, expected: str | None, output: str) -> Score:
    expected = expected or ""
    cs = cfg.get("case_sensitive", False)

    if method == "exact":
        return _binary(_normalize(output, cs) == _normalize(expected, cs))

    if method == "contains":
        return _binary(_normalize(expected, cs) in _normalize(output, cs))

    if method == "regex":
        pattern = cfg.get("pattern") or expected
        flags = 0 if cs else re.IGNORECASE
        return _binary(re.search(pattern, output, flags) is not None)

    if method == "numeric":
        got = _last_number(output)
        want = _last_number(expected)
        if got is None or want is None:
            return _binary(False, "no number found")
        tol = max(float(cfg.get("tolerance", 1e-6)), float(cfg.get("rel_tolerance", 0)) * abs(want))
        return _binary(abs(got - want) <= tol, f"got {got}, expected {want}")

    if method == "json_schema":
        try:
            data = _parse_json(output)
        except (json.JSONDecodeError, ValueError):
            return _binary(False, "output is not valid JSON")
        try:
            jsonschema.validate(data, cfg.get("schema") or {})
        except jsonschema.ValidationError as e:
            return _binary(False, f"schema: {e.message}")
        if cfg.get("match_expected") and expected:
            return _binary(data == _parse_json(expected), "compared to expected JSON")
        return _binary(True)

    if method == "json_fields":
        try:
            data = _parse_json(output)
        except (json.JSONDecodeError, ValueError):
            return _binary(False, "output is not valid JSON")
        if cfg.get("schema"):
            try:
                jsonschema.validate(data, cfg["schema"])
            except jsonschema.ValidationError as e:
                return _binary(False, f"schema: {e.message}")
        try:
            want = _parse_json(expected)
        except (json.JSONDecodeError, ValueError):
            return _binary(False, "expected value is not valid JSON")
        fields = cfg.get("fields") or (list(want) if isinstance(want, dict) else [])
        if not fields:
            return _binary(False, "no fields to compare")
        wrong = []
        for f in fields:
            got, exp = _get(data, f), _get(want, f)
            if got is _MISSING or _norm(got) != _norm(exp):
                wrong.append(f"{f}: got {'(missing)' if got is _MISSING else json.dumps(got)}, expected {json.dumps(exp)}")
        score = (len(fields) - len(wrong)) / len(fields)
        why = f"{len(fields) - len(wrong)}/{len(fields)} fields match" + (f"; {'; '.join(wrong[:4])}" if wrong else "")
        threshold = min(1.0, max(0.0, float(cfg.get("pass_threshold", 1.0))))
        return Score(score, score >= threshold, why)

    raise ValueError(f"unknown scoring method {method!r}")


JUDGE_PROMPT = """You are grading a model's answer for a benchmark.

## Task given to the model
{input}

## Reference answer / expectations
{expected}

## Grading rubric
{rubric}

## Model's answer
{output}

Grade the answer against the reference and rubric. Respond with ONLY a JSON object:
{{"score": <integer 0-10>, "reason": "<one sentence>"}}"""

DEFAULT_RUBRIC = "Is the answer correct and complete with respect to the reference? Ignore style and length."


async def judge(cfg: dict, input_: str, expected: str | None, output: str) -> Score:
    prompt = JUDGE_PROMPT.format(
        input=input_,
        expected=expected or "(none given; judge on the rubric alone)",
        rubric=cfg.get("rubric") or DEFAULT_RUBRIC,
        output=output or "(empty)",
    )
    resp = await providers.complete(
        providers.vultr_endpoint(settings.judge_model),
        [{"role": "user", "content": prompt}],
        max_tokens=2048,
        temperature=0,
    )
    text = resp["choices"][0]["message"].get("content") or ""
    try:
        verdict = _parse_json(text)
        score = max(0.0, min(10.0, float(verdict["score"]))) / 10
        reason = str(verdict.get("reason", ""))
    except (ValueError, KeyError, TypeError):
        return Score(0.0, False, f"judge returned unparseable output: {text[:200]}")
    return Score(score, score >= min(1.0, max(0.0, float(cfg.get("pass_threshold", 0.7)))), reason)


async def score(method: str, cfg: dict, input_: str, expected: str | None, output: str) -> Score:
    if method == "llm_judge":
        return await judge(cfg, input_, expected, output)
    return score_rule_based(method, cfg, expected, output)
