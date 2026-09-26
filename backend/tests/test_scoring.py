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
