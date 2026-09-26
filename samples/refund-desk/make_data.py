"""Generate the refund-desk record sources and their expected decisions from the policy.

Expected outputs are computed by the same rules the prompt states, so they are
correct by construction. Run: python samples/refund-desk/make_data.py
"""
import csv
import json
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
TODAY = date(2026, 9, 26)
CATALOG = {p["sku"]: p for p in json.load(open(HERE / "products.json"))}


def decide(sku, bought, price, opened, condition, tier):
    days = (TODAY - date.fromisoformat(bought)).days
    window = 14 if CATALOG[sku]["category"] in ("phone", "wearable") else 30
    if condition == "defective" and days <= 365:
        return "approve", price, "defective"
    if days > window:
        return "deny", 0, "outside_window"
    if not opened:
        return "approve", price, "unopened"
    if tier == "plus":
        return "approve", price, "member_waiver"
    return "partial", round(price * 0.85, 2), "restocking_fee"


# (id, tier, sku, purchase_date, price_paid, opened, condition, message)
US = [
    ("US-1001", "standard", "NB-100", "2026-09-10", 899, True, "like_new", "Changed my mind, the screen is too small. Refund please."),
    ("US-1002", "standard", "PH-300", "2026-09-10", 999, False, "sealed", "Never opened it. I want my money back."),
    ("US-1003", "plus", "NB-200", "2026-09-01", 1499, True, "like_new", "Not for me. As a Plus member I shouldn't pay any fee, right?"),
    ("US-1004", "standard", "WT-050", "2026-08-20", 249, True, "defective", "The watch won't charge at all."),
    ("US-1005", "standard", "MN-270", "2026-08-01", 329, True, "like_new", "It's DEFECTIVE, I demand a full refund!!"),
    ("US-1006", "standard", "TB-010", "2026-08-27", 449, True, "used", "Tablet is fine but I don't use it."),
    ("US-1007", "standard", "PH-310", "2026-09-12", 399, True, "used", "Honestly it's a bit defective I think. Full refund?"),
    ("US-1008", "plus", "HP-020", "2026-09-20", 129, True, "used", "Buds don't fit my ears."),
    ("US-1009", "standard", "PH-300", "2026-09-11", 999, True, "like_new", "Returning the phone, found a better deal."),
    ("US-1010", "standard", "NB-100", "2025-10-15", 899, True, "defective", "Keyboard stopped working after a few months."),
]
EU = [
    ("EU-2001", "standard", "TB-010", "2026-09-15", 449, True, "used", "Bitte erstatten, gefällt mir nicht."),
    ("EU-2002", "plus", "PH-310", "2026-09-05", 399, True, "like_new", "Please refund, plus member here."),
    ("EU-2003", "standard", "HP-020", "2026-08-27", 129, False, "sealed", "Unopened, never needed them."),
    ("EU-2004", "standard", "MN-270", "2026-09-01", 329, True, "defective", "Dead pixels everywhere."),
    ("EU-2005", "standard", "WT-050", "2026-09-12", 249, False, "sealed", "Still in the box, can I return it?"),
    ("EU-2006", "standard", "NB-200", "2026-09-19", 1499, True, "like_new", "The laptop is great but too heavy for me."),
]

# US: JSONL input, CSV expected keyed by order_id.
with open(HERE / "orders_us.jsonl", "w") as f:
    for oid, tier, sku, bought, price, opened, cond, msg in US:
        f.write(json.dumps({"order_id": oid, "customer_tier": tier, "sku": sku, "purchase_date": bought,
                            "price_paid": price, "opened": opened, "condition": cond, "customer_message": msg}) + "\n")
with open(HERE / "expected_us.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["order_id", "decision", "refund_usd", "reason_code"])
    for oid, tier, sku, bought, price, opened, cond, _ in US:
        w.writerow([oid, *decide(sku, bought, price, opened, cond, tier)])

# EU: CSV input with different column names, JSON-array expected keyed by order_ref.
with open(HERE / "orders_eu.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["order_ref", "tier", "sku", "bought_on", "amount_paid", "opened", "condition", "message"])
    for row in EU:
        oid, tier, sku, bought, price, opened, cond, msg = row
        w.writerow([oid, tier, sku, bought, price, str(opened).lower(), cond, msg])
json.dump(
    [{"order_ref": oid, **dict(zip(("decision", "refund_usd", "reason_code"), decide(sku, bought, price, opened, cond, tier)))}
     for oid, tier, sku, bought, price, opened, cond, _ in EU],
    open(HERE / "expected_eu.json", "w"), indent=2,
)

from collections import Counter
all_rows = [decide(r[2], r[3], r[4], r[5], r[6], r[1]) for r in US + EU]
print(len(US), "US +", len(EU), "EU orders; reasons:", dict(Counter(r[2] for r in all_rows)))
