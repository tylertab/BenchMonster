import json

from app.fields import FieldSpec, RowRenderer, as_text, parse_value


def test_parse_types():
    assert parse_value("21.0", FieldSpec(column="a", parse="integer")) == 21
    assert parse_value("5.89208", FieldSpec(column="a", parse="number", decimals=2)) == 5.89
    assert parse_value("7.6", FieldSpec(column="a", parse="number", decimals=0)) == 8
    assert parse_value("yes", FieldSpec(column="a", parse="boolean")) is True
    assert parse_value('{"n": 1}', FieldSpec(column="a", parse="json")) == {"n": 1}
    assert parse_value(" x ", FieldSpec(column="a", parse="text")) == " x "


def test_bad_values_fall_back_to_text():
    assert parse_value("n/a", FieldSpec(column="a", parse="integer")) == "n/a"
    assert parse_value("maybe", FieldSpec(column="a", parse="boolean")) == "maybe"
    assert parse_value("", FieldSpec(column="a", parse="number")) is None


def test_auto():
    spec = FieldSpec(column="a")
    assert parse_value("12", spec) == 12
    assert parse_value("1.5", spec) == 1.5
    assert parse_value("true", spec) is True
    assert parse_value("ENTP", spec) == "ENTP"
    assert parse_value("12", spec, "string") == "12"  # the schema says text


def test_as_text_keeps_decimals():
    spec = FieldSpec(column="a", parse="number", decimals=2)
    assert as_text(parse_value("2.1", spec), spec) == "2.10"


def test_row_renderer_selects_renames_and_parses():
    specs = [FieldSpec(column="Age", parse="integer"), FieldSpec(column="Introversion Score", name="introversion", parse="number", decimals=1)]
    r = RowRenderer(specs, ["Age", "Introversion Score", "Personality"], None)
    row = {"Age": "21.0", "Introversion Score": "5.89208", "Personality": "ENTP"}
    assert json.loads(r.record(row)) == {"Age": 21, "introversion": 5.9}
    assert r.value(row, "Introversion Score") == "5.9"
    assert r.value(row, "Personality") == "ENTP"  # not chosen for the record, still usable as a field
