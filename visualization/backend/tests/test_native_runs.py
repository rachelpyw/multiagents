import asyncio
import importlib.util
import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from agentschool_viz import native_runs, provider
from agentschool_viz.instrumentation import RunCapture
from agentschool_viz.mode_runs import StartModeRequest, write_manifest
from test_classroom_tests import lesson


def test_native_runtime_uses_entire_roster_and_bird_curriculum(tmp_path):
    service, manifest, output = lesson(tmp_path)
    manifest.roster.extend([
        manifest.roster[0].model_copy(update={"student_id": "StudentE"}),
        manifest.roster[1].model_copy(update={"student_id": "StudentF"}),
    ])
    runtime = native_runs.prepare_runtime(output, manifest)
    configs = [json.loads(path.read_text()) for path in (runtime / "config/student").glob("*.json")]
    assert {config["name"] for config in configs} == {student.student_id for student in manifest.roster}
    for config in configs:
        assert json.loads((runtime / config["folder"] / "nodes.json").read_text()) == {}
        assert "感知" in config["learning_style"]
    curriculum = json.loads((runtime / "student/数学知识点.json").read_text())
    assert all("Mallard field marks" in str(grade) for grade in curriculum.values())
    assert json.loads((runtime / "teacher/Textbook/sections.json").read_text())["sections"][1] == "Private lesson"


def test_next_class_copies_native_checkpoint_not_assessment_answers(tmp_path, monkeypatch):
    service, source, output = lesson(tmp_path)
    source.run_configuration.update(runner="native", class_number=2, language="en")
    write_manifest(output, source)
    runtime = output / "runtime"
    runtime.mkdir()
    (runtime / "checkpoint.json").write_text('{"class_number":3}')
    (runtime / "private-memory.json").write_text('{"knowledge":"student memory"}')
    assessment = source.model_copy(deep=True, update={"run_id": "test", "mode": "recorded"})
    assessment.run_configuration.update(runner="assessment", source_run_id=source.run_id, status="complete")
    test_output = service.runs_root / "test/visualization"
    test_output.mkdir(parents=True)
    write_manifest(test_output, assessment)
    (test_output / "assessment.jsonl").write_text('{"answer_key":"must not enter next class"}')
    monkeypatch.setattr(provider, "provider_configured", lambda: True)
    monkeypatch.setattr(native_runs.importlib.util, "find_spec", lambda _: True)
    launches = []
    monkeypatch.setattr(native_runs, "launch_worker", lambda *args: launches.append(args))
    result = native_runs.create_native_run(service, "test", StartModeRequest(
        configuration=source.run_configuration["experiment"], execution="live"), continuation=True)
    saved = service._run_dir(result.run_id)
    assert result.run_configuration["class_number"] == 3
    assert (saved / "runtime/private-memory.json").read_bytes() == (runtime / "private-memory.json").read_bytes()
    assert not (saved / "assessment.jsonl").exists()
    assert launches[0][1] == "agentschool_viz.native_runs"
    source.run_configuration["runner"] = "classroom"
    write_manifest(output, source)
    with pytest.raises(ValueError, match="old lightweight runner"):
        native_runs.create_native_run(service, "test", StartModeRequest(
            configuration=source.run_configuration["experiment"], execution="live"), continuation=True)


def test_teacher_experience_flag_requires_completed_update(tmp_path):
    capture = RunCapture(tmp_path / "capture")
    teacher = SimpleNamespace(name="Teacher", period="update_experience")
    capture.record_teacher(teacher, datetime(2025, 9, 1, 8))
    capture.record_teacher(teacher, datetime(2025, 9, 1, 8), experience_updated=True)
    snapshots = [json.loads(line)["payload"] for line in capture.events_path.read_text().splitlines()]
    assert [snapshot["experience_update_recorded"] for snapshot in snapshots] == [False, True]

def test_english_capture_rejects_visible_mandarin_without_altering_internal_codes(tmp_path, monkeypatch):
    from agentschool_viz.instrumentation import require_english_public_text
    monkeypatch.setenv("AGENTSCHOOL_OUTPUT_LANGUAGE", "en")
    require_english_public_text({"content": "A mallard has a yellow bill.", "focus": "思考", "method": "提问"})
    capture = RunCapture(tmp_path / "capture")
    with pytest.raises(ValueError, match="not published"):
        capture.record_student_action("StudentA", datetime(2025, 9, 1, 8), "学生正在发言")
    assert not capture.events_path.exists()

def test_translated_teaching_method_cannot_silently_publish_as_start_class(monkeypatch):
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    from teacher.teacher import Teacher
    person = Teacher.__new__(Teacher)
    person.plan_methods = ["State knowledge"]
    person.current_plan_turn = 1
    person.type = "start_class"
    with pytest.raises(ValueError, match="stale event type"):
        person.teach()


def test_native_round_keeps_messages_received_during_perception(monkeypatch):
    if importlib.util.find_spec("sentence_transformers") is None:
        pytest.skip("Install the [native] extra to exercise native Student.move.")
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    from student.cognitive_module import student as module
    person = module.Student.__new__(module.Student)
    person.name = "StudentA"
    person.infos = [{"active_event": "lecture", "content": "first"}]
    person.scratch = SimpleNamespace(current_time=datetime(2025, 9, 1, 8), action="listen")
    person.current_turn = 0
    person.update_time = lambda: None
    seen = []

    async def perceive(student, content, *_args):
        seen.append(content)
        if content == "first":
            student.infos.append({"active_event": "lecture", "content": "next round"})
        raise RuntimeError("Controlled perception failure")

    monkeypatch.setattr(module, "perceive", perceive)
    asyncio.run(person.move())
    assert seen == ["first"]
    assert person.infos == [{"active_event": "lecture", "content": "next round"}]


def test_native_memory_roundtrip_preserves_speaker_and_retrieval_metadata(tmp_path):
    pytest.importorskip("aiofiles")
    from student.cognitive_module.memory import Memory

    for name in ("nodes.json", "embeddings.json"):
        (tmp_path / name).write_text("{}")
    memory = Memory(str(tmp_path))
    created = datetime(2025, 9, 1, 8)
    node = memory.add_chat(created, "Compare bills.", ["bird"], 5,
                           ("Compare bills.", [0.1, 0.2]), s="StudentA", p="discuss", o="StudentB")
    node.theme, node.depth = ["bird identification"], 2
    node.last_accessed = created + timedelta(minutes=5)
    memory.save(str(tmp_path))
    loaded = Memory(str(tmp_path)).seq_chat[0]
    assert (loaded.s, loaded.p, loaded.o) == ("StudentA", "discuss", "StudentB")
    assert (loaded.theme, loaded.depth, loaded.last_accessed) == (node.theme, 2, node.last_accessed)


def test_native_teacher_normalizes_prompted_string_importance_before_deciding(tmp_path, monkeypatch):
    if importlib.util.find_spec("sentence_transformers") is None:
        pytest.skip("Install the [native] extra to exercise native Teacher.")
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setenv("AGENTSCHOOL_OUTPUT_LANGUAGE", "en")
    from teacher import teacher as module

    person = module.Teacher.__new__(module.Teacher)
    person.sections_file = str(tmp_path / "sections.json")
    (tmp_path / "sections.json").write_text('{"sections":["","Bird identification"]}')
    person.subsections_file = str(tmp_path / "subsections.json")
    person.current_section_turn = 2
    person.teacher_identity = "Teacher"
    person.name, person.target, person.time = "Teacher", "Identify birds", datetime(2025, 9, 1, 8)
    person.subsections, person.importance, person.focus = [], [], []
    person.update_target = lambda: None
    emitted = []
    person.broadcast_sys = SimpleNamespace(publish_sync=lambda _channel, message: emitted.append(message))
    monkeypatch.setattr(module, "call_LLM_sync", lambda *_args, **_kwargs: json.dumps({
        "subsections": [{"content": "Field marks", "score": "8", "focus": "思考"}],
    }))
    person.start_class()
    assert person.importance == [8]
    assert person.importance[0] * 1.5 == 12
    assert emitted[0].content == "Class begins. Today's goal: Identify birds"
    assert person.focus == ["思考"]


def test_native_misconception_string_is_one_observation_not_individual_characters(tmp_path):
    pytest.importorskip("numpy")
    capture = RunCapture(tmp_path / "capture")
    person = SimpleNamespace(name="StudentA", scratch=SimpleNamespace(),
                             mem=SimpleNamespace(seq_knowledge=[
                                 SimpleNamespace(misconceptions="Color alone determines the species.", knowledge_tag=["bird"]),
                             ]))
    snapshot = capture._extract_student(person)
    assert [item["text"] for item in snapshot["misconceptions"]] == ["Color alone determines the species."]


def test_native_steering_provenance_uses_only_delivered_input_and_preserves_inherited_ids():
    assert native_runs.steering_ids([
        {"observer_request_id": "direct"},
        {"steering_context_ids": ["inherited", "direct"]},
        {"observer_request_id": None, "steering_context_ids": None},
    ]) == ["direct", "inherited"]
    assert native_runs.steering_ids([{"content": "No intervention was delivered"}]) == []
