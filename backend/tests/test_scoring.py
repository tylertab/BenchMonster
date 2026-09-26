import pytest

from app.scoring import score_rule_based as s


def test_exact_normalizes_case_space_punct():
    assert s("exact", {}, "Paris", "  paris. ").passed
    assert not s("exact", {"case_sensitive": True}, "Paris", "paris").passed


def test_contains():
    assert s("contains", {}, "Paris", "The capital is PARIS!").passed
    assert not s("contains", {}, "Lyon", "Paris").passed


def test_regex_uses_expected_or_pattern():
    assert s("regex", {}, r"^\d{3}-\d{4}$", "555-1234").passed
    assert s("regex", {"pattern": "yes|true"}, None, "TRUE").passed


def test_numeric_takes_last_number_with_tolerance():
    assert s("numeric", {}, "42", "Step 1: 40 + 2. Answer: 42").passed
    assert s("numeric", {"rel_tolerance": 0.01}, "1,000", "about 1005").passed
    assert not s("numeric", {}, "7", "no idea").passed


@pytest.mark.parametrize("out", ['{"name": "a", "age": 3}', '```json\n{"name": "a", "age": 3}\n```', 'Sure! {"name": "a", "age": 3}'])
def test_json_schema_extracts_json(out):
    schema = {"type": "object", "required": ["name", "age"], "properties": {"age": {"type": "integer"}}}
    assert s("json_schema", {"schema": schema}, None, out).passed


def test_json_schema_failures_and_match_expected():
    schema = {"type": "object", "required": ["age"]}
    assert not s("json_schema", {"schema": schema}, None, '{"name": "a"}').passed
    assert not s("json_schema", {"schema": schema}, None, "not json").passed
    assert s("json_schema", {"schema": {}, "match_expected": True}, '{"a": 1}', '{"a": 1}').passed
    assert not s("json_schema", {"schema": {}, "match_expected": True}, '{"a": 1}', '{"a": 2}').passed


EXPECTED = '{"category": "billing", "priority": "high", "requires_human": true, "tags": ["refund", "invoice"]}'


def test_json_fields_partial_credit_and_rationale():
    out = '```json\n{"category": "Billing", "priority": "medium", "requires_human": true, "tags": ["invoice", "refund"], "summary": "x"}\n```'
    r = s("json_fields", {}, EXPECTED, out)
    assert r.score == 0.75 and not r.passed
    assert 'priority: got "medium", expected "high"' in r.rationale


def test_json_fields_selected_fields_threshold_and_nested():
    out = '{"category": "billing", "priority": "medium", "customer": {"tier": "pro"}}'
    exp = '{"category": "billing", "priority": "high", "customer": {"tier": "pro"}}'
    r = s("json_fields", {"fields": ["category", "customer.tier"]}, exp, out)
    assert r.score == 1.0 and r.passed
    r = s("json_fields", {"pass_threshold": 0.6}, exp, out)
    assert round(r.score, 2) == 0.67 and r.passed


def test_json_fields_invalid_and_schema():
    assert not s("json_fields", {}, EXPECTED, "not json").passed
    schema = {"type": "object", "required": ["summary"]}
    r = s("json_fields", {"schema": schema}, EXPECTED, '{"category": "billing"}')
    assert r.score == 0 and "schema" in r.rationale


def test_output_processing_json_field_then_exact():
    import asyncio

    from app.scoring import score
    cfg = {"extract": {"type": "json_field", "path": "answer.city"}}
    r = asyncio.run(score("exact", cfg, "", "Paris", 'Sure: {"answer": {"city": "Paris"}}'))
    assert r.passed and r.processed == "Paris"
    r = asyncio.run(score("exact", cfg, "", "Paris", "Paris"))
    assert not r.passed and "not valid JSON" in r.rationale


def test_output_processing_regex_group():
    import asyncio

    from app.scoring import score
    cfg = {"extract": {"type": "regex", "pattern": r"final answer:\s*(\w+)"}}
    r = asyncio.run(score("exact", cfg, "", "B", "Reasoning...\nFinal answer: B"))
    assert r.passed and r.processed == "B"
    r = asyncio.run(score("exact", cfg, "", "B", "no marker"))
    assert not r.passed and "did not match" in r.rationale
