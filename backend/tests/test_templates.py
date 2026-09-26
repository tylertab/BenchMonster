import pytest

from app.templates import TemplateError, render, variables


def test_variables_in_order_distinct_with_whitespace():
    assert variables("Q: {{question}}\nCtx: {{ context }}\nAgain {{question}}") == ["question", "context"]


def test_render_leaves_single_braces_alone():
    out = render('Return JSON like {"a": 1} for {{ x }}', {"x": "hi"})
    assert out == 'Return JSON like {"a": 1} for hi'


def test_render_missing_variable():
    with pytest.raises(TemplateError):
        render("{{a}} {{b}}", {"a": "1"})


def test_values_are_not_reinterpreted():
    assert render("{{a}}", {"a": "{{b}}"}) == "{{b}}"
