import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from agentschool_viz import app as api
from agentschool_viz import mode_runs, provider
from agentschool_viz.mode_runs import StartModeRequest, create_mode_run, execute_mode
from agentschool_viz.schemas import RunManifest, StudentManifest
from agentschool_viz.service import RunService


def classroom(tmp_path):
    service = RunService(tmp_path / "logs")
    service.fixture_root = tmp_path / "fixtures"
    source = service.fixture_root / "source"
    source.mkdir(parents=True)
    manifest = RunManifest(
        run_id="source", mode="synthetic", label="Source",
        created_at="2025-09-01T08:00:00+00:00", upstream_commit="test",
        teacher={"name": "Teacher"},
        roster=[StudentManifest(student_id=name, display_name=name, color="#456", initials=name)
                for name in ("A", "B")],
    )
    (source / "manifest.json").write_text(manifest.model_dump_json())
    (source / "events.jsonl").write_text("")
    return service, source


def request(architecture, execution="synthetic"):
    phase = {
        "phase_id": "lesson", "label": "Lesson", "architecture": architecture, "rounds": 1,
        "coordinator_id": "Teacher" if architecture == "supervisor" else None,
        "pipeline_order": ["Teacher", "A", "B"] if architecture == "pipeline" else [],
        "artifact_name": "evidence" if architecture == "pipeline" else None,
        "routes": [{"source_id": "A", "target_id": "B"}, {"source_id": "B", "target_id": "A"}]
        if architecture == "decentralized" else [],
        "blackboard": {"readers": ["Teacher", "A", "B"], "writers": ["Teacher", "A", "B"],
                       "teacher_review_required": True} if architecture == "blackboard" else None,
    }
    return StartModeRequest.model_validate({
        "execution": execution, "configuration": {
            "config_id": architecture, "label": architecture,
            "lesson_content": "Compare the mallard and teal using several features.",
            "agents": [{"agent_id": name, "display_name": name,
                        "role": "teacher" if name == "Teacher" else "student",
                        "allowed_actions": ["explain", "question", "write_board"],
                        "observable_resources": ["lesson_content"]} for name in ("Teacher", "A", "B")],
            "phases": [phase], "assessment": {"blueprint_id": "birds"},
        },
    })


@pytest.mark.parametrize("architecture", ["supervisor", "pipeline", "decentralized", "blackboard"])
def test_mode_switch_creates_distinct_policy_checked_history_without_changing_source(tmp_path, architecture):
    service, source = classroom(tmp_path)
    before = (source / "manifest.json").read_bytes()
    manifest = create_mode_run(service, "source", request(architecture))
    events = service.events(manifest.run_id)
    dialogue = [event.payload for event in events if event.event_kind == "interaction"]
    assert dialogue
    assert (source / "manifest.json").read_bytes() == before
    assert not (source / "events.jsonl").read_text()
    assert not any(event.event_kind == "assessment" for event in events)
    assert manifest.mode == "synthetic"
    if architecture == "supervisor":
        assert dialogue[0]["speaker_id"] == "Teacher"
        assert dialogue[0]["recipient_ids"] == ["A"]
        assert dialogue[1]["recipient_ids"] == ["Teacher"]
    elif architecture == "pipeline":
        assert [item["recipient_ids"] for item in dialogue] == [["A"], ["B"], []]
        versions = [json.loads(line) for line in (service._run_dir(manifest.run_id) / "artifacts.jsonl").read_text().splitlines()]
        assert [item["version"] for item in versions] == [1, 2, 3]
        assert versions[-1]["previous_version"] == 2
    elif architecture == "decentralized":
        assert [(item["speaker_id"], item["recipient_ids"]) for item in dialogue] == [("A", ["B"]), ("B", ["A"])]
    else:
        assert dialogue[-1]["active_event"] == "blackboard_review"
        versions = [json.loads(line) for line in (service._run_dir(manifest.run_id) / "artifacts.jsonl").read_text().splitlines()]
        assert versions[-1]["author_id"] == "Teacher"
        assert versions[-1]["version"] == 2


def test_live_generation_receives_only_delivered_context_and_preserves_no_demo_scores(tmp_path, monkeypatch):
    service, _ = classroom(tmp_path)
    monkeypatch.setattr(provider, "provider_configured", lambda: True)
    monkeypatch.setattr(mode_runs.subprocess, "Popen", lambda *args, **kwargs: None)

    async def no_wait(_seconds):
        pass

    monkeypatch.setattr(mode_runs.asyncio, "sleep", no_wait)
    manifest = create_mode_run(service, "source", request("pipeline", "live"))

    class Model:
        def __init__(self):
            self.received = {}

        def speak(self, person, instruction):
            self.received[person.name] = list(person.infos)
            return f"Actual model response by {person.name}"

    model = Model()
    asyncio.run(execute_mode(service._run_dir(manifest.run_id), model))
    assert model.received["Teacher"] == []
    assert [item["speaker"] for item in model.received["A"]] == ["Teacher"]
    assert [item["speaker"] for item in model.received["B"]] == ["A"]
    assert "Teacher" not in [item["speaker"] for item in model.received["B"]]
    assert service.manifest(manifest.run_id).mode == "recorded"
    assert service.manifest(manifest.run_id).run_configuration["status"] == "complete"
    assert not any(event.event_kind == "assessment" for event in service.events(manifest.run_id))
    assert all(not event.payload["concepts"] for event in service.events(manifest.run_id) if event.event_kind == "state_snapshot")


def test_api_rejects_invalid_modes_and_never_uses_demo_as_provider_failure_fallback(tmp_path, monkeypatch):
    service, _ = classroom(tmp_path)
    monkeypatch.setattr(api, "service", service)
    monkeypatch.setattr(provider, "provider_configured", lambda: False)
    client = TestClient(api.app)
    response = client.post("/api/runs/source/start", json=request("pipeline", "live").model_dump())
    assert response.status_code == 422
    assert "SCHOOLAGENT_API_KEY" in response.json()["detail"]
    assert len(service.list_runs()) == 1
    invalid = request("supervisor").model_dump()
    invalid["configuration"]["agents"][1]["agent_id"] = "outsider"
    response = client.post("/api/runs/source/start", json=invalid)
    assert response.status_code == 422
    assert len(service.list_runs()) == 1


def test_provider_failure_is_persisted_without_exposing_provider_details_or_inventing_dialogue(tmp_path, monkeypatch):
    service, _ = classroom(tmp_path)
    monkeypatch.setattr(provider, "provider_configured", lambda: True)
    monkeypatch.setattr(mode_runs.subprocess, "Popen", lambda *args, **kwargs: None)
    manifest = create_mode_run(service, "source", request("supervisor", "live"))

    class BrokenModel:
        def speak(self, person, instruction):
            raise RuntimeError("PRIVATE_PROVIDER_DETAIL")

    with pytest.raises(RuntimeError, match="Classroom failed: RuntimeError"):
        asyncio.run(execute_mode(service._run_dir(manifest.run_id), BrokenModel()))
    saved = service.manifest(manifest.run_id)
    assert saved.mode == "recorded"
    assert saved.run_configuration["status"] == "failed"
    assert "PRIVATE_PROVIDER_DETAIL" not in saved.model_dump_json()
    events = service.events(manifest.run_id)
    assert not any(event.event_kind == "interaction" for event in events)
    assert "PRIVATE_PROVIDER_DETAIL" not in "".join(event.model_dump_json() for event in events)


def test_steering_provenance_marks_only_the_later_response_that_received_it(tmp_path, monkeypatch):
    from agentschool_viz.conversations import ConversationQueue, ConversationRequest

    service, _ = classroom(tmp_path)
    monkeypatch.setattr(provider, "provider_configured", lambda: True)
    monkeypatch.setattr(mode_runs.subprocess, "Popen", lambda *args, **kwargs: None)

    async def no_wait(_seconds):
        pass

    monkeypatch.setattr(mode_runs.asyncio, "sleep", no_wait)
    manifest = create_mode_run(service, "source", request("decentralized", "live"))
    queue = ConversationQueue(service._run_dir(manifest.run_id) / "conversations.sqlite")

    class Model:
        def __init__(self):
            self.receipt = None
            self.calls = []

        def speak(self, person, instruction):
            self.calls.append((person.name, list(person.infos)))
            if self.receipt is None:
                self.receipt = queue.enqueue(ConversationRequest(source_id="A", target_id="B"))
            return f"Public observation {len(self.calls)}"

    model = Model()
    asyncio.run(execute_mode(service._run_dir(manifest.run_id), model))
    dialogue = [event.payload for event in service.events(manifest.run_id) if event.event_kind == "interaction"]
    request_id = model.receipt["request_id"]
    side_comments = [item for item in dialogue if item.get("observer_request_id")]
    assert len(side_comments) == 2
    assert all(not item["steering_context_ids"] for item in side_comments)
    assert not dialogue[0]["steering_context_ids"]
    assert dialogue[-1]["steering_context_ids"] == [request_id]
    assert any(item.get("observer_request_id") == request_id for item in model.calls[-1][1])
