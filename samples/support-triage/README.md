# Support ticket triage (structured output test)

A harder, realistic test: the prompt defines the **problem** (triage rules with an ordered
priority policy and tie-breakers), the **input structure** (`customer_tier`, `subject`, `body`),
and a strict **output structure** (JSON with enums).

| File | What |
|---|---|
| `system_prompt.txt` | System prompt |
| `template.txt` | Prompt template (v1, detailed); variables `{{customer_tier}}`, `{{subject}}`, `{{body}}` |
| `template_concise.txt` | v2: the same policy in 63% fewer words, for prompt A/B comparison |
| `tickets.csv` | 26 hand-labeled tickets; `expected` holds the correct JSON |
| `output_schema.json` | JSON schema the output must satisfy |

Traps on purpose: sarcasm, multi-issue tickets (classify the primary one), enterprise tickets
that are still `low`, a free-tier team outage that is still `urgent`, a $96 vs $479 wrong charge,
SSO failures that must be `account` even though broken, file *duplication* (not data loss).

**Run it:** prompt = template + system prompt; dataset = `tickets.csv` (variables map to
same-named columns, expected column `expected`); scoring = **JSON field match** with fields
`category, priority, requires_human, sentiment`, the schema above, pass threshold 1.
The free-text `summary` is validated by the schema but not scored.

**Prompt A/B (8 models):** detailed v1 scored 99.2% field accuracy (96.6% all-four-correct);
concise v2 scored 96.6% (87.5%) with half the input tokens and 24% lower cost. Most of the
loss is sentiment: v2 dropped the "matter-of-fact requests are neutral" clause, so every model
read "Charged twice… please refund" as negative.
