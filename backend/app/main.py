import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, runner, sqlconsole
from .config import settings
from .routers import assistant, auth, datasets, models, org, prompts, query, runs, voice

log = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await runner.fail_orphaned_runs()
    try:
        log.info("synced %d Vultr models", await models.sync_vultr_models())
    except Exception:
        log.exception("Vultr model sync failed; continuing with cached catalog")
    yield
    await sqlconsole.close_pools()
    await db.disconnect()


app = FastAPI(title="BenchMonster API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(org.router)
app.include_router(models.router)
app.include_router(prompts.router)
app.include_router(datasets.router)
app.include_router(runs.router)
app.include_router(query.router)
app.include_router(assistant.router)
app.include_router(voice.router)


@app.get("/api/health")
async def health():
    version = await db.pool().fetchval("select version()")
    return {"ok": True, "db": version.split(" on ")[0]}
