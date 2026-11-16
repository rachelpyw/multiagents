import copy
import json
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from agentschool_viz import app as api, classroom_tests, provider
from agentschool_viz.architecture import ExperimentConfiguration
from agentschool_viz.classroom_tests import bird_blueprint, create_test_run, execute_test, student_contexts
from agentschool_viz.conversations import ConversationQueue
from agentschool_viz.mode_runs import ClassroomJournal, PROJECT_ROOT, write_manifest
from agentschool_viz.schemas import RunManifest
from agentschool_viz.service import RunService


def lesson(tmp_path):
    service = RunService(tmp_path / "logs")
    manifest = RunManifest.model_validate_json((PROJECT_ROOT / "visualization/fixtures/synthetic-tutorial/manifest.json").read_text())
    manifest.run_id, manifest.mode = "lesson", "recorded"
    manifest.roster = manifest.roster[:2]
    teacher = manifest.teacher["name"]
    configuration = {
        "config_id": "test", "label": "Teacher-led", "lesson_content": "Private lesson",
        "agents": [{"agent_id": name, "display_name": name, "role": "teacher" if name == teacher else "student"}
                   for name in [teacher, *[student.student_id for student in manifest.roster]]],
        "phases": [{"phase_id": "lesson", "label": "Lesson", "architecture": "supervisor", "coordinator_id": teacher}],
        "assessment": {"blueprint_id": bird_blueprint().assessment_id},
    }
    manifest.run_configuration = {"runner": "classroom", "execution": "live", "experiment": configuration}
    output = service.runs_root / manifest.run_id / "visualization"
    output.mkdir(parents=True)
    write_manifest(output, manifest)
    journal = ClassroomJournal(output, manifest.run_id, datetime.now(timezone.utc))
    for student in manifest.roster:
        journal.append("interaction", {"speaker_id": teacher, "recipient_ids": [student.student_id],
                       "interaction_type": "explanation", "classification_source": "test",
                       "content": f"Only for {student.student_id}"}, [student.student_id])
    return service, manifest, output


def test_independent_testing_preserves_recording_and_context_isolation_with_real_scoring(tmp_path, monkeypatch):
    service, source, source_output = lesson(tmp_path)
    original = {name: (source_output / name).read_bytes() for name in ("manifest.json", "events.jsonl")}
    launches = []
    monkeypatch.setattr(classroom_tests, "provider_configured", lambda: True)
    monkeypatch.setattr(classroom_tests, "launch_worker", lambda *args: launches.append(args))
    manifest = create_test_run(service, source.run_id)
    assert create_test_run(service, source.run_id).run_id == manifest.run_id
    assert len(launches) == 1
    before = student_contexts(service.events(source.run_id), [student.student_id for student in source.roster])
    seen = []

    class Model:
        def answer(self, prompt, context, image):
            name = next(name for name in before if before[name] == context)
            assert context == before[name]
            assert f"Only for {next(other for other in before if other != name)}" not in json.dumps(context)
            assert "expected_response" not in json.dumps(context)
            seen.append((name, prompt, image))
            context["received_messages"].append({"speaker": "test mutation", "content": "not learning"})
            if "Question q4." in prompt:
                raise RuntimeError("Image provider failed")
            return "Yellow" if "Question q3." in prompt else "Mallard"

    execute_test(service._run_dir(manifest.run_id), source_output, Model())
    assert len(seen) == 8
    assert all(image is None for _, prompt, image in seen if "Question q3." in prompt)
    assert all(image for _, prompt, image in seen if "Question q3." not in prompt)
    events = service.events(manifest.run_id)
    results = [event.payload for event in events if event.event_kind == "assessment"]
    assert len(results) == 2
    for result in results:
        assert result["expected_count"] == 4
        assert result["correct_count"] == 2 and result["scorable_count"] == 3
        assert [item["status"] for item in result["item_results"]] == ["correct", "wrong", "correct", "error"]
        assert result["item_results"][1]["response"] == "Mallard"
        assert result["assessment_mode"] == "independent"
    assert service.manifest(manifest.run_id).mode == "recorded"
    assert service.manifest(manifest.run_id).run_configuration["status"] == "complete_with_errors"
    assert all((source_output / name).read_bytes() == data for name, data in original.items())
    assert before == student_contexts(service.events(source.run_id), list(before))
    assert not any(event.event_kind == "state_change" for event in events)


def test_start_test_rejects_demo_instead_of_fabricating_model_results(tmp_path, monkeypatch):
    service, manifest, output = lesson(tmp_path)
    manifest.run_configuration["execution"] = "synthetic"
    write_manifest(output, manifest)
    monkeypatch.setattr(api, "service", service)
    response = TestClient(api.app).post("/api/runs/lesson/tests")
    assert response.status_code == 409
    assert "live lesson" in response.json()["detail"]


def test_start_test_stops_live_steering_and_requests_a_safe_boundary_before_copying(tmp_path, monkeypatch):
    service, manifest, output = lesson(tmp_path)
    manifest.mode = "live"
    write_manifest(output, manifest)
    queue = ConversationQueue(output / "conversations.sqlite")
    queue.initialize()
    queue.set_ready(True)
    monkeypatch.setattr(classroom_tests, "provider_configured", lambda: True)
    monkeypatch.setattr(classroom_tests, "launch_worker", lambda *args: None)
    test = create_test_run(service, manifest.run_id)
    assert (output / "stop.requested").exists()
    assert not queue.available()
    assert service.manifest(manifest.run_id).mode == "live"
    assert test.run_configuration["status"] == "preparing_test"
    assert service.events(test.run_id) == []


def test_model_receives_png_pixels_without_observer_answer_metadata_and_recall_has_no_picture(tmp_path, monkeypatch):
    _, manifest, _ = lesson(tmp_path)
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"answer":"Yellow"}'))])

    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setattr(provider, "load_dotenv", lambda *_: None)
    monkeypatch.setattr(provider, "OpenAI", lambda **_: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    model = provider.ClassroomProvider(ExperimentConfiguration.model_validate(manifest.run_configuration["experiment"]), manifest.teacher["name"])
    context = {"received_messages": [{"speaker": "Teacher", "content": "The bill was yellow."}], "your_previous_utterances": []}
    model.answer("Identify the pictured bird.", copy.deepcopy(context), "/lesson-images/mallard-pixel.svg")
    model.answer("Recall the bill color.", copy.deepcopy(context), None)
    assert calls[0]["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert len(calls[1]["messages"][1]["content"]) == 1
    assert all("expected_response" not in json.dumps(call) and "image_alt" not in json.dumps(call) for call in calls)
    model.clients["student"].chat.completions.create = lambda **_: (_ for _ in ()).throw(provider.OpenAIError("PRIVATE_PROVIDER_DETAIL"))
    with pytest.raises(RuntimeError, match="Model request failed: OpenAIError") as error:
        model.answer("Recall the bill color.", context, None)
    assert "PRIVATE_PROVIDER_DETAIL" not in str(error.value)


def test_six_bird_test_uses_seven_independent_answers_and_no_recall_picture(tmp_path, monkeypatch):
    service, source, output = lesson(tmp_path)
    source.assessment_definitions = [classroom_tests.bird_lesson()["assessment"]]
    write_manifest(output, source)
    monkeypatch.setattr(classroom_tests, "provider_configured", lambda: True)
    monkeypatch.setattr(classroom_tests, "launch_worker", lambda *args: None)
    test = create_test_run(service, source.run_id)
    blueprint = bird_blueprint()
    seen = []

    class Model:
        def answer(self, prompt, context, image):
            item = next(item for item in blueprint.items if item.prompt == prompt)
            assert "expected_response" not in json.dumps(context)
            if item.task_type == "classification":
                assert provider.image_data_url(image).startswith("data:image/png;base64,")
            else:
                assert image is None
            seen.append((item.task_type, image))
            return item.answer_key

    execute_test(service._run_dir(test.run_id), output, Model())
    assert len({image for kind, image in seen if kind == "classification"}) == 6
    results = [event.payload for event in service.events(test.run_id) if event.event_kind == "assessment"]
    assert len(seen) == 14
    assert all(result["correct_count"] == result["expected_count"] == 7 for result in results)
