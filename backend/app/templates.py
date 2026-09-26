"""Prompt templates with {{variable}} placeholders.

Double braces keep single braces free for JSON and code inside prompts.
Whitespace inside the braces is allowed: {{ question }}.
"""

import re

VAR = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}")


class TemplateError(ValueError):
    pass


def variables(template: str) -> list[str]:
    """Distinct variable names in order of first appearance."""
    seen: dict[str, None] = {}
    for m in VAR.finditer(template):
        seen.setdefault(m.group(1))
    return list(seen)


def render(template: str, values: dict[str, str]) -> str:
    def sub(m: re.Match) -> str:
        name = m.group(1)
        if name not in values:
            raise TemplateError(f"no value for {{{{{name}}}}}")
        return values[name]

    return VAR.sub(sub, template)
