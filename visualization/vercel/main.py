from datetime import timedelta
import hashlib
import hmac
import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
import httpx
from vercel import sandbox
from vercel.sandbox import SandboxApiError, SandboxResources, SnapshotRetention

app = FastAPI(title="AgentSchool Vercel gateway")
logger = logging.getLogger(__name__)


def backend_token() -> str:
    key = os.environ.get("SCHOOLAGENT_API_KEY")
    if not key:
        raise HTTPException(503, "Configure SCHOOLAGENT_API_KEY in this Vercel project's server environment.")
    return hmac.new(key.encode(), b"agentschool-native-backend", hashlib.sha256).hexdigest()


async def classroom_origin() -> str:
    token = backend_token()
    revision = os.environ.get("VERCEL_GIT_COMMIT_SHA")
    if not revision:
        raise HTTPException(503, "The Vercel deployment is missing its source revision.")
    environment = os.environ.get("VERCEL_ENV", "development")
    name = "agentschool-production" if environment == "production" else f"agentschool-{revision[:12]}"
    box, _ = await sandbox.get_or_create_sandbox(
        name=name, persistent=True, ports=[8000],
        execution_time_limit=timedelta(minutes=45),
        resources=SandboxResources(vcpus=2, memory=4096),
        snapshot_retention=SnapshotRetention(count=1),
    )
    script = "/vercel/sandbox/ensure-classroom.py"
    await box.fs.write_text(script, Path(__file__).with_name("bootstrap.py").read_text())
    async def ensure():
        return await box.run_command(
            "python3", [script, "ensure", revision, box.current_session_id],
            env={"SCHOOLAGENT_API_KEY": os.environ["SCHOOLAGENT_API_KEY"],
                 "AGENTSCHOOL_BACKEND_TOKEN": token},
            capture_output=True, check=True,
        )

    result = await ensure()
    if result.stdout.strip() == b"needs-source":
        await box.fs.write_bytes(
            f"/vercel/sandbox/classroom-source-{revision}.tar.gz",
            Path(__file__).with_name("classroom-source.tar.gz").read_bytes(),
        )
        result = await ensure()
    if result.stdout.strip() != b"ready":
        detail = ("Native classroom startup failed. Check this project's Sandbox startup log."
                  if result.stdout.strip() == b"failed"
                  else "The native classroom is starting on Vercel. Please retry shortly.")
        raise HTTPException(503, detail,
                            headers={"Retry-After": "10"})
    for route in box.routes:
        if route.port == 8000:
            return route.url
    raise HTTPException(503, "The Vercel classroom has no API route.")


@app.api_route("/api/{path:path}", methods=["GET", "POST"])
async def proxy(request: Request, path: str):
    try:
        origin = await classroom_origin()
    except SandboxApiError as error:
        logger.error("Vercel classroom provisioning failed: %s", type(error).__name__)
        raise HTTPException(503, "Vercel could not start the native classroom. Check this project's Sandbox logs.") from None
    client = httpx.AsyncClient(timeout=httpx.Timeout(30, read=240))
    headers = {"X-Classroom-Token": backend_token()}
    for name in ("content-type", "last-event-id"):
        if name in request.headers:
            headers[name] = request.headers[name]
    try:
        upstream = await client.send(client.build_request(
            request.method, origin + "/api/" + path,
            params=request.query_params, headers=headers, content=await request.body(),
        ), stream=True)
    except httpx.RequestError as error:
        await client.aclose()
        logger.error("Native classroom connection failed: %s", type(error).__name__)
        raise HTTPException(502, "The native classroom API is temporarily unreachable.") from None

    async def content():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(content(), status_code=upstream.status_code, headers={
        name: upstream.headers[name] for name in ("content-type", "cache-control", "retry-after")
        if name in upstream.headers
    })
