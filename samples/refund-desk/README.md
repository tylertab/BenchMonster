# Refund desk (multiple input types and sources)

One prompt, five variables, four kinds of source, three file formats:

| Variable | Source | From |
|---|---|---|
| `{{today}}` | fixed text | `2026-09-26` |
| `{{policy}}` | fixed text | `policy.txt` (5 ordered rules) |
| `{{catalog}}` | whole dataset (JSON) | `products.json`, needed to look up each SKU's category |
| `{{order}}` | whole record (JSON) | each row of both record sources |
| `{{message}}` | record field | `customer_message` (US) / `message` (EU) |

Record sources (one prompt per row), each with its own expected-output file:

| Input | Format | Expected outputs | Matched on |
|---|---|---|---|
| `orders_us.jsonl` (10 orders) | JSONL | `expected_us.csv` (CSV) | `order_id = order_id` |
| `orders_eu.csv` (6 orders) | CSV, different column names | `expected_eu.json` (JSON array) | `order_ref = order_ref` |

Expected values are the whole expected row minus the key: `{decision, refund_usd, reason_code}`.
They are computed from the policy by `make_data.py`, so they're correct by construction. Traps:
customers claiming "defective" against the record, 14-day windows for phones/wearables (needs
the catalog), plus-member fee waivers, and orders exactly on the last day of a window.

Output handling (profile-wide): the reply's `DECISION: {...}` line is pulled out with the regex
`DECISION:\s*(\{.*\})`, then **JSON field match** compares `decision`, `refund_usd`, and
`reason_code` (all must match to pass).

Create it through the API: `python samples/refund-desk/create_profile.py BASE_URL login:EMAIL/PASSWORD MODEL_ID,...`
