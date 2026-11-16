from __future__ import annotations

import copy
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .architecture import ExperimentConfiguration
from .assessment import AssessmentBlueprint, AssessmentItem, run_isolated_assessment
from .conversations import ConversationQueue
from .mode_runs import PROJECT_ROOT, ClassroomJournal, launch_worker, write_manifest, participant_contexts, lesson_contexts
from .provider import ClassroomProvider, provider_configured
from .schemas import NormalizedEvent, RunManifest, SourceRecordRef
from .service import RunService


def bird_blueprint() -> AssessmentBlueprint:
    reference = json.loads((PROJECT_ROOT / "visualization/fixtures/synthetic-tutorial/manifest.json").read_text())
    definition = reference["assessment_definitions"][0]
    aliases = {"q1": ("Mallard duck", "Anas platyrhynchos"),
               "q2": ("American green-winged teal", "Anas carolinensis", "Anas crecca"),
               "q4": ("Rock dove", "Columba livia")}
    return AssessmentBlueprint(definition["assessment_id"], tuple(
        AssessmentItem(
            item_id=item["item_id"], prompt=f'Question {item["item_id"]}. {item["prompt"]}',
            answer_key=item["expected_response"], label=item["label"], task_type=item["task_type"],
            image_url=item.get("image_url"), image_alt=item.get("image_alt"),
            answer_aliases=aliases.get(item["item_id"], ()),
        ) for item in definition["item_definitions"]
    ))


student_contexts = participant_contexts


def create_test_run(service: RunService, source_id: str) -> RunManifest:
    source = service.manifest(source_id)
    if source.run_configuration.get("runner") not in {"classroom", "native"} or source.run_configuration.get("execution") != "live":
        raise ValueError("Choose a mode to begin a live lesson before starting its test.")
    if source.run_configuration.get("runner") == "native" and source.run_configuration.get("language") != "en":
        raise ValueError("Choose a mode to start an English classroom before testing. Older recordings are preserved.")
    if not provider_configured():
        raise ValueError("A model-provider key is required to evaluate the students.")
    blueprint = bird_blueprint()
    if not source.roster or len(source.roster) * len(blueprint.items) > 64:
        raise ValueError("This test supports up to 64 model answers per session.")
    source_output = service._run_dir(source_id)
    with sqlite3.connect(source_output / "tests.sqlite") as db:
        db.execute("CREATE TABLE IF NOT EXISTS request (id INTEGER PRIMARY KEY, run_id TEXT)")
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT run_id FROM request WHERE id=1").fetchone()
        if existing:
            return service.manifest(existing[0])
        run_id = f"test-{uuid4().hex[:12]}"
        output = service.runs_root.resolve() / run_id / "visualization"
        output.mkdir(parents=True)
        manifest = source.model_copy(deep=True, update={
            "run_id": run_id, "mode": "live", "label": "Independent bird test",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "run_configuration": {**source.run_configuration, "runner": "assessment",
                                  "source_run_id": source_id, "status": "preparing_test"},
        })
        write_manifest(output, manifest)
        (output / "events.jsonl").touch()
        db.execute("INSERT INTO request VALUES (1, ?)", (run_id,))
    try:
        launch_worker(output, "agentschool_viz.classroom_tests", str(source_output.resolve()))
    except OSError as error:
        manifest.mode = "recorded"
        manifest.run_configuration.update(status="failed", error=f"Test worker could not start: {type(error).__name__}.")
        write_manifest(output, manifest)
        raise ValueError(manifest.run_configuration["error"]) from None
    if source.mode == "live":
        queue = ConversationQueue(source_output / "conversations.sqlite")
        if queue.path.exists():
            queue.set_ready(False)
        (source_output / "stop.requested").touch()
    return manifest


def execute_test(output: Path, source_output: Path, provider: Any = None) -> None:
    manifest = RunManifest.model_validate_json((output / "manifest.json").read_text())
    teacher_id = str(manifest.teacher.get("name", "Teacher"))
    journal = ClassroomJournal(output, manifest.run_id, datetime.now(timezone.utc))
    try:
        deadline = time.monotonic() + 600
        while RunManifest.model_validate_json((source_output / "manifest.json").read_text()).mode == "live":
            if time.monotonic() > deadline:
                raise TimeoutError("The lesson did not reach a safe test boundary.")
            time.sleep(.25)
        service = RunService(source_output.parent.parent)
        events = service.events(manifest.run_configuration["source_run_id"])
        contexts = lesson_contexts(source_output, events, [student.student_id for student in manifest.roster])
        source = RunManifest.model_validate_json((source_output / "manifest.json").read_text())
        if source.run_configuration.get("runner") == "native":
            if not (source_output / "native-test-contexts.json").exists():
                raise ValueError("The native class did not save its cognitive memory for testing.")
            contexts = json.loads((source_output / "native-test-contexts.json").read_text())
            if set(contexts) != {student.student_id for student in manifest.roster}:
                raise ValueError("The native checkpoint does not contain every student's cognitive memory.")
        identifiers = {event.event_id: f"{manifest.run_id}:{index}" for index, event in enumerate(events)}
        for index, event in enumerate(events):
            payload = copy.deepcopy(event.payload)
            if "source_event_ids" in payload:
                payload["source_event_ids"] = [identifiers.get(event_id, event_id) for event_id in payload["source_event_ids"]]
            journal.append(event.event_kind, payload, event.student_ids, simulation_time=event.simulation_time,
                           sources=[*event.source_record_refs, SourceRecordRef(path=str(source_output / "events.jsonl"), line=index + 1)])
        blueprint = bird_blueprint()
        configuration = ExperimentConfiguration.model_validate(manifest.run_configuration["experiment"])
        if provider is None:
            provider = ClassroomProvider(configuration, teacher_id)
        manifest.run_configuration["status"] = "testing"
        write_manifest(output, manifest)
        journal.append("agent_action", {"agent_id": teacher_id, "role": "teacher",
                                       "action": "Independent test", "phase": "test"}, [])
        # Observer-only snapshots are not prompts: each answer receives only this student's own context.
        (output / "test-contexts.json").write_text(json.dumps(contexts), encoding="utf-8")
        images = {item.prompt: item.image_url if item.task_type == "classification" else None for item in blueprint.items}
        error_count = 0
        for index, student in enumerate(manifest.roster):
            journal.append("agent_action", {"agent_id": teacher_id, "role": "teacher", "phase": "test",
                                           "action": f"Testing {student.display_name} · {index + 1}/{len(manifest.roster)}"}, [])
            result = run_isolated_assessment(
                student_id=student.student_id, checkpoint="final", blueprint=blueprint,
                state_snapshot=contexts[student.student_id], test_timing="immediate",
                answer_provider=lambda prompt, state: provider.answer(prompt, state, images[prompt]),
            )
            with (output / "assessment.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(result.model_dump_json() + "\n")
            error_count += sum(item.status == "error" for item in result.item_results)
            journal.append("assessment", result.model_dump(), [student.student_id],
                           sources=[SourceRecordRef(path="assessment.jsonl", line=index + 1, hook="run_isolated_assessment")])
        manifest.run_configuration["status"] = "complete_with_errors" if error_count else "complete"
        journal.append("agent_action", {"agent_id": teacher_id, "role": "teacher", "phase": "test_complete",
                                       "action": f"Test complete · {error_count} model errors" if error_count else "Test complete"}, [])
    except Exception as error:
        detail = f"Test failed: {type(error).__name__}. No substitute answers were generated."
        manifest.run_configuration.update(status="failed", error=detail)
        journal.append("agent_action", {"agent_id": teacher_id, "role": "teacher", "phase": "test_failed", "action": detail}, [])
        raise RuntimeError(detail) from None
    finally:
        manifest.mode = "recorded"
        write_manifest(output, manifest)


if __name__ == "__main__":
    execute_test(Path(sys.argv[1]), Path(sys.argv[2]))
