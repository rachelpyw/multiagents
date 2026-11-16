from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .service import RunNotFoundError, RunService
from .architecture import ExperimentConfiguration, configuration_schema
from .conversations import ConversationQueue, ConversationRequest, ConversationUnavailable
from .mode_runs import StartModeRequest, create_mode_run
from .classroom_tests import create_test_run
from .provider import provider_configured
from .native_runs import create_native_run

app = FastAPI(title="AgentSchool classroom visualization")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
service = RunService()


@app.get("/api/classroom")
def classroom_settings():
    return {"live_available": provider_configured()}


@app.post("/api/runs/{run_id}/tests", status_code=201)
def start_test(run_id: str):
    try:
        return create_test_run(service, run_id).model_dump()
    except RunNotFoundError as error:
        raise HTTPException(status_code=404, detail="Run not found") from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/runs/{run_id}/next-class", status_code=201)
def next_class(run_id: str):
    try:
        source = service.manifest(run_id)
        request = StartModeRequest(configuration=source.run_configuration["experiment"],
                                   execution=source.run_configuration["execution"])
        return create_native_run(service, run_id, request, continuation=True).model_dump()
    except RunNotFoundError as error:
        raise HTTPException(status_code=404, detail="Run not found") from error
    except (ValueError, KeyError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


def conversation_queue(run_id: str, *, require_live: bool = True) -> ConversationQueue:
    try:
        manifest = service.manifest(run_id)
        if require_live and manifest.mode != "live":
            raise HTTPException(status_code=409, detail="This is an immutable replay. Start an interactive live run to steer conversations.")
        return ConversationQueue(service._run_dir(run_id) / "conversations.sqlite")
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


@app.get("/api/runs/{run_id}/conversations")
def conversation_capability(run_id: str):
    queue = conversation_queue(run_id, require_live=False)
    manifest = service.manifest(run_id)
    return {"available": manifest.mode == "live" and queue.available(), "mode": manifest.mode,
            "error": manifest.run_configuration.get("error"), "status": manifest.run_configuration.get("status")}


@app.post("/api/runs/{run_id}/start", status_code=201)
def start_mode_run(run_id: str, request: StartModeRequest):
    try:
        manifest = (create_native_run if request.execution == "live" else create_mode_run)(service, run_id, request)
        previous = service.manifest(run_id)
        if previous.mode == "live" and previous.run_configuration.get("runner") in {"classroom", "native"}:
            (service._run_dir(run_id) / "stop.requested").touch()
        return manifest.model_dump()
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/runs/{run_id}/conversations", status_code=202)
def request_conversation(run_id: str, request: ConversationRequest):
    queue = conversation_queue(run_id)
    roster = {student.student_id for student in service.manifest(run_id).roster}
    if request.source_id not in roster or request.target_id not in roster or request.source_id == request.target_id:
        raise HTTPException(status_code=422, detail="Choose two different students from this run.")
    try:
        return queue.enqueue(request)
    except ConversationUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/runs/{run_id}/conversations/{request_id}")
def conversation_receipt(run_id: str, request_id: str):
    queue = conversation_queue(run_id, require_live=False)
    if not queue.path.exists():
        raise HTTPException(status_code=404, detail="Conversation not found")
    try:
        return queue.receipt(request_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Conversation not found") from exc


@app.get("/api/experiment-config/schema")
def get_experiment_configuration_schema():
    return configuration_schema()


@app.post("/api/experiment-config/validate")
def validate_experiment_configuration(configuration: ExperimentConfiguration):
    return configuration.model_dump()


@app.get("/api/runs")
def list_runs():
    return [manifest.model_dump() for manifest in service.list_runs()]


@app.get("/api/runs/{run_id}/manifest")
def get_manifest(run_id: str):
    try:
        return service.manifest(run_id).model_dump()
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


@app.get("/api/runs/{run_id}/events")
def get_events(run_id: str):
    try:
        return [event.model_dump() for event in service.events(run_id)]
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


@app.get("/api/runs/{run_id}/stream")
def stream_events(run_id: str):
    try:
        service.manifest(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc
    return StreamingResponse(service.stream(run_id), media_type="text/event-stream")
