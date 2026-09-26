"""Connections to an org's own storage and databases: S3-compatible object storage
(Vultr Object Storage, AWS S3, R2, MinIO...) and Postgres (Tiger Cloud, Supabase, RDS...).

Credentials are encrypted at rest and never returned to the browser. Every host is
checked before connecting so a connection can't be pointed at the server's own
network (cloud metadata, the app database, other containers).
"""

import asyncio
import datetime as dt
import decimal
import ipaddress
import json
import re
import socket
import uuid
from typing import Literal
from urllib.parse import urlparse

import asyncpg
import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from pydantic import BaseModel, Field

from .config import settings
from .datasets import MAX_ROWS

MAX_OBJECT_BYTES = 25 * 1024 * 1024
FILE_TYPES = (".csv", ".jsonl", ".ndjson", ".json")
PG_TIMEOUT_S = 15


class ConnectionError_(HTTPException):
    def __init__(self, detail: str):
        super().__init__(400, detail)


# --- configs -----------------------------------------------------------------------


class S3Config(BaseModel):
    endpoint: str = Field(min_length=1, max_length=500)  # e.g. https://ewr1.vultrobjects.com
    region: str = Field("us-east-1", max_length=50)
    bucket: str = Field(min_length=1, max_length=255)
    prefix: str = Field("", max_length=500)  # folder BenchMonster works in (optional)


class S3Secret(BaseModel):
    access_key: str = Field(min_length=1, max_length=500)
    secret_key: str = Field(min_length=1, max_length=500)


class PgConfig(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(5432, ge=1, le=65535)
    database: str = Field(min_length=1, max_length=100)
    user: str = Field(min_length=1, max_length=100)
    sslmode: Literal["require", "verify-full", "prefer", "disable"] = "require"
    schema_: str = Field("public", alias="schema", max_length=100)  # where exports create tables

    model_config = {"populate_by_name": True}


class PgSecret(BaseModel):
    password: str = Field(min_length=1, max_length=500)


def parse_config(kind: str, config: dict, secret: dict | None):
    if kind == "s3":
        return S3Config(**config), S3Secret(**secret) if secret is not None else None
    return PgConfig(**config), PgSecret(**secret) if secret is not None else None


def public_config(kind: str, config: dict) -> dict:
    cfg, _ = parse_config(kind, config, None)
    return cfg.model_dump(by_alias=True)


# --- secrets -----------------------------------------------------------------------


def _fernet() -> Fernet:
    if not settings.connection_secret_key:
        raise HTTPException(500, "connections are not configured on this server (CONNECTION_SECRET_KEY is missing)")
    return Fernet(settings.connection_secret_key.encode())


def encrypt(secret: dict) -> bytes:
    return _fernet().encrypt(json.dumps(secret).encode())


def decrypt(blob: bytes) -> dict:
    try:
        return json.loads(_fernet().decrypt(bytes(blob)))
    except InvalidToken:
        raise HTTPException(500, "saved credentials can't be decrypted (the server's key changed); re-enter them")


# --- host safety -------------------------------------------------------------------


async def check_host(host: str) -> None:
    """Refuse hosts that resolve to private, loopback, link-local or reserved addresses."""
    if settings.allow_private_connections:
        return
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except socket.gaierror:
        raise ConnectionError_(f"can't resolve host {host!r}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise ConnectionError_(f"{host} resolves to a private or reserved address ({ip}); use a public endpoint")


def _endpoint_host(endpoint: str) -> str:
    u = urlparse(endpoint)
    if u.scheme not in ("https", "http") or not u.hostname:
        raise ConnectionError_("endpoint must be a URL like https://ewr1.vultrobjects.com")
    if u.scheme == "http" and not settings.allow_private_connections:
        raise ConnectionError_("endpoint must use https")
    return u.hostname


# --- S3 ----------------------------------------------------------------------------


def _s3(cfg: S3Config, sec: S3Secret):
    return boto3.client(
        "s3", endpoint_url=cfg.endpoint.rstrip("/"), region_name=cfg.region or "us-east-1",
        aws_access_key_id=sec.access_key, aws_secret_access_key=sec.secret_key,
        config=BotoConfig(connect_timeout=5, read_timeout=30, retries={"max_attempts": 2},
                          s3={"addressing_style": "path"}, signature_version="s3v4"),
    )


def _s3_error(e: Exception) -> str:
    if isinstance(e, ClientError):
        code = e.response.get("Error", {}).get("Code", "")
        return {
            "NoSuchBucket": "the bucket doesn't exist",
            "AccessDenied": "access denied",
            "InvalidAccessKeyId": "the access key isn't recognized",
            "SignatureDoesNotMatch": "the secret key is wrong",
            "NoSuchKey": "the file doesn't exist",
            "403": "access denied",
            "404": "not found",
        }.get(code, f"{code}: {e.response.get('Error', {}).get('Message', '')}".strip(": "))
    if isinstance(e, EndpointConnectionError):
        return "can't reach the endpoint"
    return str(e)[:300]


def _key(cfg: S3Config, path: str) -> str:
    prefix = cfg.prefix.strip("/")
    path = path.lstrip("/")
    if ".." in path.split("/"):
        raise ConnectionError_("invalid path")
    return f"{prefix}/{path}" if prefix else path


async def s3_check(cfg: S3Config, sec: S3Secret, allow_write: bool) -> dict:
    await check_host(_endpoint_host(cfg.endpoint))
    client = _s3(cfg, sec)
    prefix = cfg.prefix.strip("/")
    try:
        r = await asyncio.to_thread(client.list_objects_v2, Bucket=cfg.bucket, Prefix=f"{prefix}/" if prefix else "", MaxKeys=1000)
    except (ClientError, BotoCoreError) as e:
        return {"read": False, "write": None, "detail": f"can't list {cfg.bucket}: {_s3_error(e)}"}
    files = sum(1 for o in r.get("Contents", []) if o["Key"].lower().endswith(FILE_TYPES))
    detail = f"can list {cfg.bucket}{'/' + prefix if prefix else ''} ({files}{'+' if r.get('IsTruncated') else ''} data files)"
    if not allow_write:
        return {"read": True, "write": None, "detail": detail}
    probe = _key(cfg, f".benchmonster-access-check-{uuid.uuid4().hex[:8]}")
    try:
        await asyncio.to_thread(client.put_object, Bucket=cfg.bucket, Key=probe, Body=b"ok")
    except (ClientError, BotoCoreError) as e:
        return {"read": True, "write": False, "detail": f"{detail}; writing failed: {_s3_error(e)}"}
    try:
        await asyncio.to_thread(client.delete_object, Bucket=cfg.bucket, Key=probe)
    except (ClientError, BotoCoreError):
        pass  # write-only-no-delete policies are fine; the probe file is tiny
    return {"read": True, "write": True, "detail": f"{detail}; can write files"}


async def s3_browse(cfg: S3Config, sec: S3Secret, folder: str) -> dict:
    """Folders and data files directly inside `folder` (relative to the connection's prefix)."""
    await check_host(_endpoint_host(cfg.endpoint))
    client = _s3(cfg, sec)
    folder = folder.strip("/")
    base = _key(cfg, folder + "/") if folder else (cfg.prefix.strip("/") + "/" if cfg.prefix.strip("/") else "")
    strip = len(cfg.prefix.strip("/") + "/") if cfg.prefix.strip("/") else 0
    try:
        r = await asyncio.to_thread(client.list_objects_v2, Bucket=cfg.bucket, Prefix=base, Delimiter="/", MaxKeys=1000)
    except (ClientError, BotoCoreError) as e:
        raise ConnectionError_(f"can't list {cfg.bucket}: {_s3_error(e)}")
    folders = [p["Prefix"][strip:].rstrip("/") for p in r.get("CommonPrefixes", [])]
    files = [
        {"path": o["Key"][strip:], "size": o["Size"], "modified": o["LastModified"].isoformat()}
        for o in r.get("Contents", []) if o["Key"].lower().endswith(FILE_TYPES)
    ]
    return {"folder": folder, "folders": folders, "files": files, "truncated": bool(r.get("IsTruncated"))}


async def s3_read(cfg: S3Config, sec: S3Secret, path: str) -> tuple[bytes, str]:
    """(file bytes, etag)."""
    await check_host(_endpoint_host(cfg.endpoint))
    client = _s3(cfg, sec)
    key = _key(cfg, path)
    if not key.lower().endswith(FILE_TYPES):
        raise ConnectionError_("choose a .csv, .jsonl or .json file")
    try:
        head = await asyncio.to_thread(client.head_object, Bucket=cfg.bucket, Key=key)
        if head["ContentLength"] > MAX_OBJECT_BYTES:
            raise ConnectionError_(f"{path} is {head['ContentLength'] / 1e6:.1f} MB; the limit is {MAX_OBJECT_BYTES // 1_000_000} MB")
        obj = await asyncio.to_thread(client.get_object, Bucket=cfg.bucket, Key=key)
        body = await asyncio.to_thread(obj["Body"].read, MAX_OBJECT_BYTES + 1)
    except (ClientError, BotoCoreError) as e:
        raise ConnectionError_(f"can't read {path}: {_s3_error(e)}")
    return body, head.get("ETag", "").strip('"')


async def s3_etag(cfg: S3Config, sec: S3Secret, path: str) -> str | None:
    client = _s3(cfg, sec)
    try:
        head = await asyncio.to_thread(client.head_object, Bucket=cfg.bucket, Key=_key(cfg, path))
    except (ClientError, BotoCoreError):
        return None
    return head.get("ETag", "").strip('"')


async def s3_write(cfg: S3Config, sec: S3Secret, path: str, body: bytes, content_type: str) -> str:
    await check_host(_endpoint_host(cfg.endpoint))
    client = _s3(cfg, sec)
    key = _key(cfg, path)
    try:
        await asyncio.to_thread(client.put_object, Bucket=cfg.bucket, Key=key, Body=body, ContentType=content_type)
    except (ClientError, BotoCoreError) as e:
        raise ConnectionError_(f"can't write {path}: {_s3_error(e)}")
    return key


# --- Postgres ----------------------------------------------------------------------


async def pg_connect(cfg: PgConfig, sec: PgSecret) -> asyncpg.Connection:
    await check_host(cfg.host)
    try:
        return await asyncpg.connect(
            host=cfg.host, port=cfg.port, user=cfg.user, password=sec.password, database=cfg.database,
            ssl=None if cfg.sslmode == "disable" else cfg.sslmode, timeout=8, command_timeout=PG_TIMEOUT_S + 5,
            server_settings={"application_name": "benchmonster"},
        )
    except (OSError, asyncio.TimeoutError, asyncpg.PostgresError, asyncpg.InterfaceError) as e:
        raise ConnectionError_(f"can't connect to {cfg.host}: {str(e)[:300] or type(e).__name__}")


async def pg_check(cfg: PgConfig, sec: PgSecret, allow_write: bool) -> dict:
    try:
        conn = await pg_connect(cfg, sec)
    except HTTPException as e:
        return {"read": False, "write": None, "detail": e.detail}
    try:
        row = await conn.fetchrow(
            """select current_user as who, current_setting('transaction_read_only') = 'on' as read_only,
                      (select count(*) from information_schema.tables t
                        where t.table_schema not in ('pg_catalog', 'information_schema', 'toolkit_experimental')
                          and t.table_schema !~ '^_?timescaledb'
                          and has_table_privilege(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'SELECT')) as readable,
                      has_schema_privilege($1, 'CREATE') as can_create""",
            cfg.schema_,
        )
    except asyncpg.PostgresError as e:
        return {"read": False, "write": None, "detail": f"connected, but checking access failed: {e}"}
    finally:
        await conn.close()
    detail = f"connected as {row['who']}; can read {row['readable']} tables/views"
    if not allow_write:
        return {"read": row["readable"] > 0, "write": None, "detail": detail}
    if row["read_only"]:
        return {"read": row["readable"] > 0, "write": False, "detail": f"{detail}; the server is read-only (a replica?)"}
    if not row["can_create"]:
        return {"read": row["readable"] > 0, "write": False, "detail": f"{detail}; can't create tables in schema {cfg.schema_}"}
    return {"read": row["readable"] > 0, "write": True, "detail": f"{detail}; can create tables in schema {cfg.schema_}"}


async def pg_tables(cfg: PgConfig, sec: PgSecret) -> list[dict]:
    conn = await pg_connect(cfg, sec)
    try:
        rows = await conn.fetch(
            """select t.table_schema as schema, t.table_name as name, t.table_type as type,
                      (select array_agg(c.column_name::text order by c.ordinal_position) from information_schema.columns c
                        where c.table_schema = t.table_schema and c.table_name = t.table_name) as columns,
                      coalesce((select greatest(cl.reltuples, 0)::bigint from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
                        where n.nspname = t.table_schema and cl.relname = t.table_name), 0) as approx_rows
               from information_schema.tables t
               where t.table_schema not in ('pg_catalog', 'information_schema', 'toolkit_experimental')
                 and t.table_schema !~ '^_?timescaledb'
                 and has_table_privilege(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'SELECT')
               order by t.table_schema = 'public' desc, t.table_schema, t.table_name
               limit 500"""
        )
    finally:
        await conn.close()
    return [dict(r) for r in rows]


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, default=str)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (decimal.Decimal, uuid.UUID)):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "\\x" + bytes(v).hex()
    return str(v)


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _where(rules: list, columns: set[str], match: str) -> tuple[str, list]:
    """Filter rules (see selection.Rule) as a SQL WHERE clause on text-cast columns."""
    clauses, args = [], []

    def arg(v) -> str:
        args.append(v)
        return f"${len(args)}"

    for r in rules:
        if r.field not in columns:
            raise ConnectionError_(f"filter field {r.field!r} is not a column of the table")
        col = f"{_ident(r.field)}::text"
        v = r.value.strip()
        num = None
        try:
            num = float(v)
        except ValueError:
            pass
        clause = {
            "eq": lambda: f"{col} = {arg(v)}",
            "neq": lambda: f"{col} is distinct from {arg(v)}",
            "in": lambda: f"lower({col}) = any({arg([x.strip().lower() for x in r.value.split(',') if x.strip()])}::text[])",
            "not_in": lambda: f"not coalesce(lower({col}) = any({arg([x.strip().lower() for x in r.value.split(',') if x.strip()])}::text[]), false)",
            "contains": lambda: f"{col} ilike '%' || {arg(v)} || '%'",
            "not_contains": lambda: f"coalesce({col}, '') not ilike '%' || {arg(v)} || '%'",
            "empty": lambda: f"coalesce({col}, '') = ''",
            "not_empty": lambda: f"coalesce({col}, '') <> ''",
            "regex": lambda: f"{col} ~ {arg(r.value)}",
        }.get(r.op)
        if clause:
            clauses.append(clause())
            continue
        sql_op = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[r.op]
        if num is not None:  # numeric compare; non-numeric cells don't match
            clauses.append(f"(case when {col} ~ '^\\s*-?[0-9.]+(e[+-]?[0-9]+)?\\s*$' then {col}::numeric {sql_op} {arg(num)}::numeric else false end)")
        else:
            clauses.append(f"lower({col}) {sql_op} lower({arg(v)})")
    if not clauses:
        return "", args
    return "where " + (" and " if match == "all" else " or ").join(f"({c})" for c in clauses), args


async def pg_read(cfg: PgConfig, sec: PgSecret, *, table: str | None = None, query: str | None = None,
                  rules: list | None = None, match: str = "all") -> tuple[list[str], list[dict[str, str]]]:
    """Rows of a table (optionally filtered) or of a read-only SELECT, capped at MAX_ROWS."""
    conn = await pg_connect(cfg, sec)
    try:
        async with conn.transaction(readonly=True):
            await conn.execute(f"set local statement_timeout = '{PG_TIMEOUT_S}s'")
            if table:
                schema, _, name = table.rpartition(".")
                schema = schema or "public"
                cols = await conn.fetch(
                    """select column_name::text from information_schema.columns
                       where table_schema = $1 and table_name = $2 order by ordinal_position""", schema, name,
                )
                if not cols:
                    raise ConnectionError_(f"table {table} not found (or no access)")
                columns = [c[0] for c in cols]
                where, args = _where(rules or [], set(columns), match)
                sql = f"select * from {_ident(schema)}.{_ident(name)} {where} limit {MAX_ROWS + 1}"
            else:
                query = (query or "").strip().rstrip(";")
                if not re.match(r"(?is)^\s*(select|with|values|table)\b", query):
                    raise ConnectionError_("only SELECT queries can import rows")
                sql = f"select * from ({query}) q limit {MAX_ROWS + 1}"
                args = []
            try:
                stmt = await conn.prepare(sql)
                records = await stmt.fetch(*args)
                columns = [a.name for a in stmt.get_attributes()]
            except asyncpg.PostgresError as e:
                raise ConnectionError_(f"query failed: {e}")
    finally:
        await conn.close()
    if len(records) > MAX_ROWS:
        raise ConnectionError_(f"more than {MAX_ROWS:,} rows; add filters to import fewer")
    if not records:
        raise ConnectionError_("no rows matched")
    return columns, [{c: _cell(r[i]) for i, c in enumerate(columns)} for r in records]


async def pg_write(cfg: PgConfig, sec: PgSecret, writes: list[tuple[str, dict[str, str], list[tuple]]],
                   replace_run_id: int | None = None) -> int:
    """For each (table, {column: sql type}, rows): create schema.table if needed and insert the rows,
    all in one transaction. With replace_run_id, that run's earlier rows are deleted first
    (so exporting a run twice doesn't duplicate it). Returns rows written."""
    conn = await pg_connect(cfg, sec)
    written = 0
    try:
        async with conn.transaction():
            await conn.execute(f"set local statement_timeout = '{PG_TIMEOUT_S * 4}s'")
            for table, columns, rows in writes:
                target = f"{_ident(cfg.schema_)}.{_ident(table)}"
                await conn.execute(
                    f"create table if not exists {target} ({', '.join(f'{_ident(c)} {t}' for c, t in columns.items())})"
                )
                if replace_run_id is not None:
                    await conn.execute(f"delete from {target} where run_id = $1", replace_run_id)
                placeholders = ", ".join(f"${i + 1}::{t}" for i, t in enumerate(columns.values()))
                await conn.executemany(
                    f"insert into {target} ({', '.join(_ident(c) for c in columns)}) values ({placeholders})", rows
                )
                written += len(rows)
    except asyncpg.PostgresError as e:
        raise ConnectionError_(f"writing to schema {cfg.schema_} failed: {e}")
    finally:
        await conn.close()
    return written


# --- dispatch ----------------------------------------------------------------------


async def check(kind: str, config: dict, secret: dict, allow_write: bool) -> dict:
    cfg, sec = parse_config(kind, config, secret)
    try:
        result = await (s3_check(cfg, sec, allow_write) if kind == "s3" else pg_check(cfg, sec, allow_write))
    except HTTPException as e:
        result = {"read": False, "write": None, "detail": e.detail}
    return {**result, "checked_at": dt.datetime.now(dt.timezone.utc).isoformat()}
