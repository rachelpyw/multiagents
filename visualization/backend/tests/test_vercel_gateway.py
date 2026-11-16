import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import httpx
import pytest

from agentschool_viz.app import app as native_app


@pytest.fixture
def gateway():
    path = Path(__file__).resolve().parents[2] / "vercel/main.py"
    spec = importlib.util.spec_from_file_location("classroom_vercel_gateway", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_native_backend_requires_internal_token_only_when_configured(monkeypatch):
    client = TestClient(native_app)
    monkeypatch.setenv("AGENTSCHOOL_BACKEND_TOKEN", "internal-test-token")
    assert client.get("/api/runs").status_code == 401
    assert client.get("/api/runs", headers={"X-Classroom-Token": "wrong"}).status_code == 401
    assert client.get("/api/runs", headers={"X-Classroom-Token": "internal-test-token"}).status_code == 200
    monkeypatch.delenv("AGENTSCHOOL_BACKEND_TOKEN")
    assert client.get("/api/runs").status_code == 200


def test_gateway_startup_is_explicit_and_never_uses_synthetic_fallback(gateway, monkeypatch):
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "test-revision")
    monkeypatch.setenv("VERCEL_ENV", "production")
    clock = iter([0, 241])
    monkeypatch.setattr(gateway, "monotonic", lambda: next(clock))
    box = SimpleNamespace(
        fs=SimpleNamespace(write_text=AsyncMock()),
        run_command=AsyncMock(return_value=SimpleNamespace(stdout=b"starting\n")),
        current_session_id="session-1",
    )
    provision = AsyncMock(return_value=(box, False))
    monkeypatch.setattr(gateway.sandbox, "get_or_create_sandbox", provision)
    response = TestClient(gateway.app).get("/api/runs")
    assert response.status_code == 503
    assert response.headers["retry-after"] == "10"
    assert "starting" in response.json()["detail"]
    assert provision.call_args.kwargs["persistent"] is True
    assert "unit-test-placeholder" not in response.text


def test_gateway_preserves_api_method_body_query_and_errors(gateway, monkeypatch):
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setattr(gateway, "classroom_origin", AsyncMock(return_value="https://native.invalid"))
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(409, json={"detail": "Conversation unavailable"})

    original = httpx.AsyncClient
    monkeypatch.setattr(gateway.httpx, "AsyncClient",
                        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs))
    response = TestClient(gateway.app).post("/api/runs/run-1/conversations?follow=true",
                                           json={"source_id": "A", "target_id": "B"},
                                           headers={"X-Classroom-Token": "untrusted"})
    assert response.status_code == 409
    assert response.json() == {"detail": "Conversation unavailable"}
    assert seen[0].method == "POST"
    assert str(seen[0].url) == "https://native.invalid/api/runs/run-1/conversations?follow=true"
    assert seen[0].headers["X-Classroom-Token"] == gateway.backend_token()
    assert b'"source_id":"A"' in seen[0].content


def test_gateway_uploads_committed_source_when_runtime_needs_it(gateway, monkeypatch):
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "test-revision")
    monkeypatch.setattr(gateway.Path, "read_bytes", lambda self: b"committed-source")
    box = SimpleNamespace(
        fs=SimpleNamespace(write_text=AsyncMock(), write_bytes=AsyncMock()),
        run_command=AsyncMock(side_effect=[
            SimpleNamespace(stdout=b"needs-source\n"), SimpleNamespace(stdout=b"ready\n"),
        ]),
        current_session_id="session-1",
        routes=[SimpleNamespace(port=8000, url="https://native.invalid")],
    )
    monkeypatch.setattr(gateway.sandbox, "get_or_create_sandbox", AsyncMock(return_value=(box, False)))
    assert asyncio.run(gateway.classroom_origin()) == "https://native.invalid"
    box.fs.write_bytes.assert_awaited_once_with(
        "/vercel/sandbox/classroom-source-test-revision.tar.gz", b"committed-source",
    )
    assert box.run_command.await_count == 2


def test_gateway_waits_for_cold_start_before_serving_first_request(gateway, monkeypatch):
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "test-revision")
    monkeypatch.setattr(gateway.asyncio, "sleep", AsyncMock())
    box = SimpleNamespace(
        fs=SimpleNamespace(write_text=AsyncMock()),
        run_command=AsyncMock(side_effect=[
            SimpleNamespace(stdout=b"starting\n"), SimpleNamespace(stdout=b"ready\n"),
        ]),
        current_session_id="session-1",
        routes=[SimpleNamespace(port=8000, url="https://native.invalid")],
    )
    monkeypatch.setattr(gateway.sandbox, "get_or_create_sandbox", AsyncMock(return_value=(box, False)))
    assert asyncio.run(gateway.classroom_origin()) == "https://native.invalid"
    assert box.run_command.await_count == 2


def test_gateway_proxies_sse_without_buffering(gateway, monkeypatch):
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setattr(gateway, "classroom_origin", AsyncMock(return_value="https://native.invalid"))
    original = httpx.AsyncClient
    monkeypatch.setattr(gateway.httpx, "AsyncClient", lambda **kwargs: original(
        transport=httpx.MockTransport(lambda _: httpx.Response(
            200, text="data: native-event\n\n", headers={"content-type": "text/event-stream"})), **kwargs))
    response = TestClient(gateway.app).get("/api/runs/run-1/stream")
    assert response.headers["content-type"] == "text/event-stream"
    assert response.text == "data: native-event\n\n"
