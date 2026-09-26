"""Create the Refund desk benchmark profile through the API, then run it.

python samples/refund-desk/create_profile.py BASE_URL (login:EMAIL/PASSWORD | cookie:TOKEN) MODEL_ID[,MODEL_ID...]
"""
import json, sys, time, uuid, urllib.request, http.cookiejar
from pathlib import Path

HERE = Path(__file__).parent
B, auth, models = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
hdr = {"cookie": f"bm_session={auth[7:]}"} if auth.startswith("cookie:") else {}

def call(m, p, b=None):
    req = urllib.request.Request(B + p, json.dumps(b).encode() if b is not None else None, {"content-type": "application/json", **hdr}, method=m)
    try: return json.loads(op.open(req, timeout=900).read())
    except urllib.error.HTTPError as e: sys.exit(f"{m} {p} -> {e.code} {e.read()[:400]}")

def upload(fn, description):
    bnd = uuid.uuid4().hex
    parts = [f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\n\r\n'.encode() + (HERE / fn).read_bytes(),
             f'\r\n--{bnd}\r\nContent-Disposition: form-data; name="description"\r\n\r\n{description}'.encode()]
    body = b"".join(parts) + f"\r\n--{bnd}--\r\n".encode()
    req = urllib.request.Request(B + "/api/datasets", body, {"content-type": f"multipart/form-data; boundary={bnd}", **hdr}, method="POST")
    return json.loads(op.open(req).read())

if auth.startswith("login:"):
    email, pw = auth[6:].split("/", 1); call("POST", "/api/auth/login", {"email": email, "password": pw})

catalog = upload("products.json", "Nimbus product catalog: sku, name, category, price, stock, specs.")
us = upload("orders_us.jsonl", "US refund requests: one order per line with the customer's message.")
us_exp = upload("expected_us.csv", "Correct refund decisions for orders_us.jsonl, keyed by order_id.")
eu = upload("orders_eu.csv", "EU refund requests (different column names than the US file).")
eu_exp = upload("expected_eu.json", "Correct refund decisions for orders_eu.csv, keyed by order_ref.")
ids = {m["model_id"]: m["id"] for m in call("GET", "/api/models")}

config = {
    "prompt_name": "Refund desk v1",
    "system_prompt": "You are precise and follow policies exactly. You never invent facts that are not in the order record.",
    "template": (HERE / "template.txt").read_text(),
    "bindings": {
        "today": {"type": "text", "value": "2026-09-26"},
        "policy": {"type": "text", "value": (HERE / "policy.txt").read_text().strip()},
        "catalog": {"type": "dataset", "dataset_id": catalog["id"], "format": "json"},
    },
    "datasets": [
        {"dataset_id": us["id"], "mapping": {"order": "$record", "message": "customer_message"},
         "expected_dataset_id": us_exp["id"], "input_key": "order_id", "expected_key": "order_id", "expected_column": None},
        {"dataset_id": eu["id"], "mapping": {"order": "$record", "message": "message"},
         "expected_dataset_id": eu_exp["id"], "input_key": "order_ref", "expected_key": "order_ref", "expected_column": None},
    ],
    "scoring_method": "json_fields",
    "scoring_config": {"extract": {"type": "regex", "pattern": r"DECISION:\s*(\{.*\})"},
                       "fields": ["decision", "refund_usd", "reason_code"], "pass_threshold": 1},
    "model_ids": [ids[m] for m in models], "max_tokens": 4096, "temperature": 0, "concurrency": 8, "mode": "realtime",
}
p = call("POST", "/api/profiles", {"name": "Refund desk (multi-source)", "config": config, "note": "Created",
     "description": "Fixed text (today, policy) + whole dataset (catalog) + whole record and a record field from two differently shaped files (JSONL + CSV), with expected decisions in CSV and JSON files. Replies are processed with a regex, then compared field by field."})
print("profile", p["id"], "v", p["current_version"])
r = call("POST", f"/api/profiles/{p['id']}/runs", {"name": "Refund desk baseline"})
while (x := call("GET", f"/api/runs/{r['id']}"))["status"] not in ("completed", "failed"): time.sleep(4)
print("run", r["id"], x["status"], x["total_inputs"], "inputs from", [d["filename"] for d in x["datasets"]])
for s in sorted(x["summary"], key=lambda s: -(s["accuracy"] or 0)):
    print(f"  {s['model']:26} field-acc={s['accuracy']:.3f} all-3={s['pass_rate']:.2f} p50={s['p50_latency_ms']:.0f}ms cost=${float(s['total_cost_usd']):.4f} errors={s['errors']}")
print("RUN_ID", r["id"], "PROFILE_ID", p["id"])
