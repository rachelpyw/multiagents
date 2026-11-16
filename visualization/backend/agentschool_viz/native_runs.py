from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
import os
import shutil
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from .architecture import ArchitecturePolicy, Blackboard, PipelineHistory, register_architecture_subscriptions
from .mode_runs import PROJECT_ROOT, StartModeRequest, launch_worker, write_manifest
from .schemas import NormalizedEvent, RunManifest, SourceRecordRef
from .service import RunService


def steering_ids(messages: list[dict]) -> list[str]:
    return sorted({request_id for message in messages for request_id in
                   ([message["observer_request_id"]] if message.get("observer_request_id") else [])
                   + (message.get("steering_context_ids") or [])})


def create_native_run(service: RunService, source_id: str, request: StartModeRequest, *, continuation: bool = False) -> RunManifest:
    from .provider import provider_configured
    from .classroom_tests import bird_lesson

    source = service.manifest(source_id)
    if not provider_configured():
        raise ValueError("Save SCHOOLAGENT_API_KEY in the local .env file before starting AgentSchool.")
    missing = [name for name in ("numpy", "sentence_transformers", "hnswlib", "aiofiles", "demjson3", "tiktoken")
               if importlib.util.find_spec(name) is None]
    if missing:
        raise ValueError("Native dependencies missing: " + ", ".join(missing) + ". Install the backend's [native] extra.")
    known = {student.student_id for student in source.roster} | {str(source.teacher["name"])}
    if {agent.agent_id for agent in request.configuration.agents} != known:
        raise ValueError("Use this classroom's teacher and student IDs.")
    if len(request.configuration.phases) != 1:
        raise ValueError("Choose one classroom architecture.")
    if request.configuration.budget.max_tokens is not None:
        raise ValueError("Native token-budget enforcement is unavailable; use round, message, or time boundaries.")
    previous_runtime = None
    if continuation:
        if (source.mode != "recorded" or source.run_configuration.get("runner") not in {"assessment", "native"}
                or source.run_configuration.get("status") not in {"complete", "complete_with_errors"}):
            raise ValueError("Finish the current class or test before resuming the live classroom.")
        lesson = (service.manifest(source.run_configuration["source_run_id"])
                  if source.run_configuration.get("runner") == "assessment" else source)
        if lesson.run_configuration.get("runner") != "native":
            raise ValueError("This historical test used the old lightweight runner. Choose a mode to begin a native AgentSchool class.")
        if lesson.run_configuration.get("language") != "en":
            raise ValueError("This older class contains non-English memory. Choose a mode to start an English classroom; its original recording is preserved.")
        previous_runtime = service._run_dir(lesson.run_id) / "runtime"
        if not (previous_runtime / "checkpoint.json").exists():
            raise ValueError("The native class has no completed memory checkpoint.")
    run_id = f"native-{uuid4().hex[:12]}"
    output = service.runs_root.resolve() / run_id / "visualization"
    output.mkdir(parents=True)
    manifest = source.model_copy(deep=True, update={
        "run_id": run_id, "mode": "live", "label": "AgentSchool · " + request.configuration.label,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "run_configuration": {"runner": "native", "execution": "live", "status": "initializing", "language": "en",
                              "experiment": request.configuration.model_dump(),
                              "class_number": int(source.run_configuration.get("class_number", 1)) + 1 if continuation else 1,
                              **({"previous_class_run_id": source_id} if continuation else {})},
    })
    definition = bird_lesson()["assessment"]
    if request.configuration.assessment.blueprint_id == definition["assessment_id"]:
        manifest.assessment_definitions = [definition]
    write_manifest(output, manifest)
    (output / "events.jsonl").touch()
    if previous_runtime:
        shutil.copytree(previous_runtime, output / "runtime")
    try:
        launch_worker(output, "agentschool_viz.native_runs")
    except OSError as error:
        manifest.mode = "recorded"
        manifest.run_configuration.update(status="failed", error=f"Native worker could not start: {type(error).__name__}.")
        write_manifest(output, manifest)
        raise ValueError(manifest.run_configuration["error"]) from None
    return manifest


def prepare_runtime(output: Path, manifest: RunManifest) -> Path:
    runtime = output / "runtime"
    if (runtime / "checkpoint.json").exists():
        for folder in ("student", "teacher", "util"):
            for source in (PROJECT_ROOT / folder).rglob("*.py"):
                destination = runtime / source.relative_to(PROJECT_ROOT)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
        (runtime / "teacher/Textbook/sections.json").write_text(json.dumps(
            {"sections": ["", manifest.run_configuration["experiment"]["lesson_content"]]}))
        return runtime
    runtime.mkdir(exist_ok=True)
    for folder in ("student", "teacher", "util", "config"):
        shutil.copytree(PROJECT_ROOT / folder, runtime / folder,
                        ignore=shutil.ignore_patterns("__pycache__", "saving", "students", "model_cache", "*.pdf"),
                        dirs_exist_ok=True)
    (runtime / "teacher/Status").mkdir(exist_ok=True)
    configuration = manifest.run_configuration["experiment"]
    teacher_path = runtime / "config/teacher.json"
    teacher = json.loads(teacher_path.read_text())
    instruction = {
        "supervisor": "Lead individual teacher-student exchanges and synthesize their reports. Do not schedule peer-only discussions.",
        "pipeline": "Initiate sequential evidence-building. Only the next student receives each stage's contribution; do not assume everyone heard you.",
        "decentralized": "Facilitate comparisons through the configured peer network and respond to students' reports.",
        "blackboard": "Invite public evidence and comparisons on the shared blackboard, then review the contributed claims.",
    }[configuration["phases"][0]["architecture"]]
    teacher.update(name=manifest.teacher["name"], subject="bird_identification",
                   overall_target="Identify birds from multiple field marks and preserve uncertainty.",
                   teaching_strategy=teacher["teaching_strategy"] + "\nClassroom architecture: " + instruction,
                   teacher_identity=teacher["teacher_identity"] + "\nGive public classroom speech in English. Preserve required JSON keys and teaching-method labels.")
    teacher_path.write_text(json.dumps(teacher, ensure_ascii=False))
    (runtime / "teacher/Textbook/sections.json").write_text(json.dumps({"sections": ["", configuration["lesson_content"]]}))
    curriculum = {}
    configs = {item["name"]: item for path in (runtime / "config/student").glob("*.json")
               if (item := json.loads(path.read_text()))}
    for path in (runtime / "config/student").glob("*.json"):
        path.unlink()
    template = next(iter(configs.values()))
    for student in manifest.roster:
        config = copy.deepcopy(configs.get(student.student_id, template))
        config.update({key: value for key, value in student.attributes.items() if key in config})
        config.update(name=student.student_id, folder=f"student/students/{student.student_id}")
        style = config["learning_style"]
        for english, native in (("Perception", "感知"), ("Processing", "处理"), ("Understanding", "理解")):
            if english in style:
                style[native] = style.pop(english)
        (runtime / f"config/student/{student.student_id}.json").write_text(json.dumps(config))
        folder = runtime / config["folder"]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "scratch.json").write_text(json.dumps(config, ensure_ascii=False))
        for name in ("nodes.json", "embeddings.json"):
            (folder / name).write_text("{}")
        curriculum[config["grade"]] = {"nodes": [
            {"id": "bird.fieldmarks", "name": "Identifying birds from multiple field marks", "parent_id": None},
            *[{"id": item.get("concept_id", "bird." + item["item_id"]),
               "name": item["label"] + " field marks", "parent_id": "bird.fieldmarks"}
              for item in manifest.assessment_definitions[0]["item_definitions"]
              if item["task_type"] == "classification"],
        ]}
    (runtime / "student/数学知识点.json").write_text(json.dumps(curriculum))
    return runtime


async def execute_native(output: Path) -> None:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env")
    manifest = RunManifest.model_validate_json((output / "manifest.json").read_text())
    runtime = prepare_runtime(output, manifest)
    os.chdir(runtime)
    sys.path.insert(0, str(runtime))
    # Native embedding hooks support a configured model; share a small real BGE model.
    os.environ.setdefault("BGE_MODEL", "BAAI/bge-small-zh-v1.5")
    os.environ.setdefault("BGE_MODEL_L", os.environ["BGE_MODEL"])
    os.environ["AGENTSCHOOL_OUTPUT_LANGUAGE"] = "en"
    from student.cognitive_module import student as student_module
    from student.knowledge_graph import kg
    from teacher.teacher import Teacher
    from util.BroadcastMessage import BroadcastMessage, MessageType
    from util.BroadcastSys import BroadcastSys
    from util.Recorder import Recorder
    from .architecture import ExperimentConfiguration
    from .conversations import ConversationQueue, process_conversation
    from .instrumentation import RunCapture, require_english_public_text

    configuration = ExperimentConfiguration.model_validate(manifest.run_configuration["experiment"])
    phase = configuration.phases[0]
    policy = ArchitecturePolicy(configuration)
    checkpoint = json.loads((runtime / "checkpoint.json").read_text()) if (runtime / "checkpoint.json").exists() else {}
    clock = datetime.fromisoformat(checkpoint.get("simulation_time", "2025-09-01T08:00:00"))
    capture = RunCapture(output.parent, runtime)
    # RunCapture's native extraction is reused; retain the launcher's stable roster and metadata.
    write_manifest(output, manifest)
    capture.current_simulation_time = str(clock)
    errors = []
    input_contexts = {}

    def endpoint(name, agent_id, status):
        capture._append(NormalizedEvent(
            run_id=manifest.run_id, event_id=f"{manifest.run_id}:endpoint:{capture.sequence}",
            sequence=capture.sequence, simulation_time=str(clock), event_kind="agent_action",
            student_ids=[agent_id] if agent_id != manifest.teacher["name"] else [],
            source_record_refs=[SourceRecordRef(
                path="runtime/teacher/teacher.py" if agent_id == manifest.teacher["name"] else f"runtime/student/{name}.py",
                hook=name)],
            payload={"agent_id": agent_id, "role": "teacher" if agent_id == manifest.teacher["name"] else "student",
                     "action": f"{name} · {status}", "endpoint": name, "status": status, "phase": "cognitive",
                     "steering_context_ids": input_contexts.get(agent_id, [])},
        ))

    for name in ("perceive", "retrieve", "reflect", "execute"):
        original = getattr(student_module, name)

        def observe(function, stage):
            async def wrapped(person, *args, **kwargs):
                endpoint(stage, person.name, "started")
                try:
                    result = await function(person, *args, **kwargs)
                    if stage == "perceive" and (not isinstance(result, tuple) or len(result) != 3):
                        raise TypeError("Native perceive did not return its node, absorbed information, and learning result.")
                except Exception as error:
                    errors.append((person.name, stage, type(error).__name__))
                    endpoint(stage, person.name, f"failed: {type(error).__name__}")
                    raise
                endpoint(stage, person.name, "threshold not met" if stage == "reflect" and not result else "completed")
                return result
            return wrapped
        setattr(student_module, name, observe(original, name))
    original_plan = student_module.plan

    def plan(person, *args, **kwargs):
        endpoint("plan", person.name, "started")
        try:
            result = original_plan(person, *args, **kwargs)
        except Exception as error:
            errors.append((person.name, "plan", type(error).__name__))
            endpoint("plan", person.name, f"failed: {type(error).__name__}")
            raise
        endpoint("plan", person.name, "completed")
        return result
    student_module.plan = plan

    board = Blackboard(phase.blackboard) if phase.blackboard else None
    pipeline = PipelineHistory(phase.artifact_name) if phase.artifact_name else None

    class Transport(BroadcastSys):
        public_messages = 0

        def publish_sync(self, channel, message):
            require_english_public_text({"content": message.content})
            if not message.observer_request_id:
                message.steering_context_ids = input_contexts.get(message.speaker, [])
            if message.active_event != "expression":
                self.public_messages += 1
            if phase.architecture == "blackboard" and message.active_event != "expression":
                channel = "blackboard:write"
                if message.speaker in phase.blackboard.writers:
                    entry = board.write(agent_id=message.speaker, entry_id=message.speaker, kind="claim", content=message.content)
                    with (output / "artifacts.jsonl").open("a") as stream:
                        stream.write(entry.model_dump_json() + "\n")
            elif phase.architecture == "pipeline" and message.active_event != "expression":
                channel = f"artifact:{phase.artifact_name}"
                artifact = pipeline.revise(message.speaker, message.content)
                with (output / "artifacts.jsonl").open("a") as stream:
                    stream.write(artifact.model_dump_json() + "\n")
            super().publish_sync(channel, message)

    transport = Transport(Recorder(str(output / "broadcast_log.jsonl")))
    transport.enable_debug(False)
    transport.set_delivery_policy(policy)
    transport.add_event_listener(capture.record_broadcast)
    students = {}
    for path in sorted((runtime / "config/student").glob("*.json")):
        config = json.loads(path.read_text())
        person = student_module.Student(config["name"], transport, Recorder(str(output / "student_log.jsonl")), config["folder"])
        person.public_language = "English"
        person.scratch.current_time = clock
        person.current_course_number = int(manifest.run_configuration.get("class_number", 1)) - 1
        person.scratch.chat_buffer = [
            person.mem.id_to_node[node_id] for node_id in checkpoint.get("chat_buffers", {}).get(person.name, [])
        ]
        students[person.name] = person
    teacher = await Teacher.initialize_teacher_async(transport, str(runtime / "config/teacher.json"), list(students.values()))
    teacher.time = clock
    teacher.class_number = manifest.run_configuration.get("class_number", 1)
    teacher.class_turns = configuration.budget.max_turns or 40
    for person in students.values():
        person.update_students_list(list(students.values()))
    register_architecture_subscriptions(transport, policy, {teacher.name: teacher, **students})
    queue = ConversationQueue(output / "conversations.sqlite")
    queue.initialize()
    if (runtime / "knowledge-graph.json").exists():
        restored = type(kg).load_json(str(runtime / "knowledge-graph.json"))
        kg.__dict__.update(restored.__dict__)
    capture.record_students(students, clock)
    manifest.run_configuration["status"] = "running"
    write_manifest(output, manifest)
    started = time.monotonic()
    try:
        for _ in range(teacher.class_turns):
            if (output / "stop.requested").exists():
                break
            budget = configuration.budget
            if ((budget.max_messages is not None and transport.public_messages >= budget.max_messages)
                    or (budget.time_minutes is not None and time.monotonic() - started >= budget.time_minutes * 60)):
                manifest.run_configuration["budget_boundary_reached"] = True
                endpoint("class_budget", teacher.name, "round boundary reached")
                break
            queue.set_ready(True)
            input_contexts[teacher.name] = steering_ids(teacher.received)
            action = teacher.move()
            capture.record_teacher(teacher, clock, action)
            ordered = phase.pipeline_order if pipeline else list(students)
            async def move_student(name):
                if name not in students:
                    return
                person = students[name]
                input_contexts[name] = steering_ids(person.infos)
                before = len(person.mem.seq_knowledge)
                result = await person.move()
                capture.record_student_action(name, clock, result)
                if pipeline and len(person.mem.seq_knowledge) > before:
                    transport.publish_sync(f"artifact:{phase.artifact_name}", BroadcastMessage(
                        current_time=clock, message_type=MessageType.CLASS, active_event="lecture",
                        speaker=name, content=person.mem.seq_knowledge[0].content))
            if pipeline:
                for name in ordered:
                    await move_student(name)
            else:
                await asyncio.gather(*(move_student(name) for name in ordered))
            await process_conversation(queue, students, teacher, transport, clock, assistance_allowed=True)
            capture.record_students(students, clock)
            clock += timedelta(seconds=60)
            capture.current_simulation_time = str(clock)
            if teacher.period == "update_experience":
                break
            await asyncio.sleep(.1)
        queue.set_ready(False)
        if teacher.period != "update_experience":
            teacher.finish_class()
            for name, person in students.items():
                input_contexts[name] = steering_ids(person.infos)
            await asyncio.gather(*(person.move() for person in students.values()))
            clock += timedelta(seconds=60)
            teacher.time = clock
            capture.current_simulation_time = str(clock)
            capture.record_students(students, clock)
        input_contexts[teacher.name] = steering_ids(teacher.received)
        endpoint("update_experience", teacher.name, "started")
        teacher.update_experience()
        endpoint("update_experience", teacher.name, "completed")
        capture.record_teacher(teacher, clock, experience_updated=True)
        contexts = {}
        for name, person in students.items():
            folder = runtime / f"student/students/{name}"
            person.mem.save(str(folder))
            person.scratch.save(str(folder / "scratch.json"))
            contexts[name] = {
                "knowledge": [{"content": node.content, "misconceptions": node.misconceptions}
                              for node in person.mem.seq_knowledge[:person.scratch.retention]],
                "reflections": [node.content for node in person.mem.seq_thought[:person.scratch.retention]],
                "persona": capture.last_snapshot[name]["persona"],
                "received_messages": [{"speaker": node.s, "content": node.content}
                                      for node in person.mem.seq_chat[:person.scratch.retention]],
            }
        (output / "native-test-contexts.json").write_text(json.dumps(contexts, ensure_ascii=False))
        kg.save_json(str(runtime / "knowledge-graph.json"))
        (runtime / "checkpoint.json").write_text(json.dumps({
            "class_number": teacher.class_number, "simulation_time": clock.isoformat(),
            "chat_buffers": {name: [node.node_id for node in person.scratch.chat_buffer]
                             for name, person in students.items()},
        }))
        manifest.run_configuration["status"] = "complete_with_errors" if errors else "complete"
        manifest.run_configuration["cognitive_errors"] = errors
    except Exception as error:
        traceback.print_tb(error.__traceback__)
        detail = f"Native AgentSchool failed: {type(error).__name__}. No replacement dialogue was generated."
        manifest.run_configuration.update(status="failed", error=detail)
        endpoint("runtime", teacher.name, detail)
        raise RuntimeError(detail) from None
    finally:
        queue.close()
        manifest.mode = "recorded"
        write_manifest(output, manifest)


if __name__ == "__main__":
    output = Path(sys.argv[1]).resolve()
    try:
        asyncio.run(execute_native(output))
    except Exception as error:
        traceback.print_tb(error.__traceback__)
        manifest = RunManifest.model_validate_json((output / "manifest.json").read_text())
        manifest.mode = "recorded"
        if manifest.run_configuration.get("status") != "failed":
            manifest.run_configuration.update(status="failed", error=f"Native runtime failed: {type(error).__name__}.")
        write_manifest(output, manifest)
        print(manifest.run_configuration["error"], flush=True)
        sys.exit(1)
