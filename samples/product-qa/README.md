# Product Q&A (inlined context)

Shows variables that are NOT per-record: the whole `products.json` catalog is inlined into every
prompt, while `questions.csv` supplies one question per record.

Template: `Catalog:\n{{catalog}}\n\nQuestion: {{question}}\nAnswer with the SKU only.`
- `{{catalog}}`  ← whole dataset `products.json` (as JSON)
- `{{question}}` ← record field `question` of `questions.csv`; expected column `answer`; scoring **contains**

Or a single prompt: bind `{{question}}` to fixed text and give a fixed expected output.
