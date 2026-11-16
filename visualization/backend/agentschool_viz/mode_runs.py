from __future__ import annotations

import asyncio
import copy
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel

from .architecture import ArchitecturePolicy, Blackboard, ExperimentConfiguration, PipelineHistory
from .schemas import NormalizedEvent, RunManifest, SourceRecordRef
from .service import RunService

PROJECT_ROOT = Path(__file__).resolve().parents[3]
MODE_LABELS = {
    "supervisor": "Teacher-led", "pipeline": "Sequential relay",
    "decentralized": "Peer network", "blackboard": "Shared blackboard",
}


class StartModeRequest(BaseModel):
    configuration: ExperimentConfiguration
    execution: Literal["synthetic", "live"] = "synthetic"


def write_manifest(output: Path, manifest: RunManifest) -> None:
    temporary = output / "manifest.tmp"
    temporary.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(output / "manifest.json")


def launch_worker(output: Path, module: str, *arguments: str) -> None:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT) + os.pathsep + str(PROJECT_ROOT / "visualization/backend")
    with (output / "worker.log").open("a") as log:
        subprocess.Popen([sys.executable, "-m", module, str(output), *arguments],
                         cwd=PROJECT_ROOT, env=environment, stdout=log, stderr=log)


class ClassroomJournal:
    def __init__(self, output: Path, run_id: str, clock: datetime):
        self.output, self.run_id, self.clock = output, run_id, clock
        self.sequence = 0

    def append(self, kind: Literal["interaction", "state_snapshot", "agent_action", "instructor_snapshot", "assessment", "state_change"],
               payload: dict[str, Any], ids: list[str], *, simulation_time: str | None = None,
               sources: list[SourceRecordRef] | None = None) -> NormalizedEvent:
        event = NormalizedEvent(
            run_id=self.run_id, event_id=f"{self.run_id}:{self.sequence}", sequence=self.sequence,
            simulation_time=simulation_time or self.clock.isoformat(), event_kind=kind, student_ids=ids,
            source_record_refs=sources or [SourceRecordRef(path="classroom.jsonl", hook="classroom-runner")], payload=payload,
        )
        with (self.output / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(event.model_dump_json() + "\n")
        self.sequence += 1
        timestamp = datetime.fromisoformat(event.simulation_time.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        self.clock = max(self.clock, timestamp) + timedelta(seconds=30)
        return event


@dataclass(frozen=True)
class Step:
    author: str
    channel: str
    action: str
    instruction: str
    demo: str


def mode_steps(configuration: ExperimentConfiguration) -> list[Step]:
    if len(configuration.phases) != 1:
        raise ValueError("The classroom launcher runs one mode at a time; export multi-phase configurations for the native runner.")
    phase = configuration.phases[0]
    students = [agent.agent_id for agent in configuration.agents if agent.role not in {"teacher", "coordinator"}]
    teacher = next((agent.agent_id for agent in configuration.agents if agent.role in {"teacher", "coordinator"}), None)
    if teacher is None:
        raise ValueError("The classroom launcher requires a teacher or coordinator role.")
    if configuration.budget.max_tokens is not None:
        raise ValueError("Token-budget enforcement is not available in this launcher. Use turn/message limits instead.")
    steps = []
    if phase.architecture == "supervisor":
        teacher = phase.coordinator_id or teacher
        for student in [agent.agent_id for agent in configuration.agents if agent.agent_id != teacher]:
            steps.extend([
                Step(teacher, student, "ask_question", "Delegate one bird-identification comparison to this student.",
                     "Compare the mallard's green head and yellow bill with the teal's chestnut head and green eye patch. Which clues help you distinguish them?"),
                Step(student, teacher, "feedback", "Report your comparison and uncertainty to the teacher.",
                     "I will check bill color as well as head markings, rather than identifying a bird from green coloring alone."),
            ])
        steps.append(Step(teacher, "student", "lecture", "Summarize the reports you actually received.",
                          "Use several visible features together. A shared color alone does not establish a species."))
    elif phase.architecture == "pipeline":
        for index, author in enumerate(phase.pipeline_order):
            steps.append(Step(
                author, f"artifact:{phase.artifact_name}", "pipeline_handoff",
                "Revise the incoming evidence card, retaining uncertainty; pass the improved card to the next stage.",
                "Evidence card update: "
                + ["Compare head pattern first.", "Check the bill, not just head color.", "A mallard drake has a yellow bill.",
                   "A teal has a chestnut head with a green eye patch.", "Compare body size and pattern too.",
                   "Keep an unfamiliar bird uncertain rather than calling every bird a duck.",
                   "Final card: combine head, bill, body shape, and uncertainty."][index % 7],
            ))
    elif phase.architecture == "decentralized":
        for route in phase.routes:
            if route.allowed:
                steps.append(Step(route.source_id, route.target_id, "group_discussion",
                                  "Share one bird-identification clue with this permitted neighbor; respond to observations you actually received.",
                                  f"I am comparing the bill and eye patch. {route.target_id}, what feature would you check before choosing a species?"))
    else:
        if not phase.blackboard:
            raise ValueError("Blackboard permissions are required.")
        writers = phase.blackboard.writers
        ordered = ([teacher] if teacher in writers else []) + [agent for agent in writers if agent != teacher]
        for author in ordered:
            steps.append(Step(author, "blackboard:write", "blackboard_write",
                              "Post a concise claim or question to the shared bird-identification board, building only on entries you may read.",
                              "Board claim: compare the mallard's yellow bill with the teal's chestnut-and-green head pattern. Do not rely on one color."))
        if phase.blackboard.teacher_review_required and teacher in writers:
            steps.append(Step(teacher, "blackboard:write", "blackboard_review",
                              "Review the visible board entries. Correct conflicts and summarize remaining uncertainty.",
                              "Teacher review: combine bill shape, head pattern and size; an unfamiliar species still needs independent evidence."))
    limit = min(configuration.budget.max_messages or 40, configuration.budget.max_turns or 24, 40)
    if not steps:
        raise ValueError("This mode has no executable routes or permitted writers.")
    planned = [steps[index % len(steps)] for index in range(min(limit, len(steps) * phase.rounds))]
    for step in planned:
        agent = next(agent for agent in configuration.agents if agent.agent_id == step.author)
        action = "write_board" if step.action.startswith("blackboard") else "question" if step.action == "ask_question" else "explain"
        if action not in agent.allowed_actions:
            raise ValueError(f"{agent.display_name} does not permit the required '{action}' action.")
    return planned


def participant_contexts(events: list[NormalizedEvent], roster: list[str], initial: dict | None = None) -> dict[str, dict[str, Any]]:
    contexts = {name: copy.deepcopy((initial or {}).get(name, {"received_messages": [], "your_previous_utterances": []}))
                for name in roster}
    for event in events:
        if event.event_kind != "interaction":
            continue
        payload = event.payload
        speaker, content = payload["speaker_id"], payload["content"]
        if speaker in contexts:
            contexts[speaker]["your_previous_utterances"].append(content)
        for recipient in payload.get("recipient_ids") or []:
            if recipient in contexts:
                message = {"speaker": speaker, "content": content}
                if payload.get("observer_request_id"):
                    message["observer_request_id"] = payload["observer_request_id"]
                contexts[recipient]["received_messages"].append(message)
    for context in contexts.values():
        context["received_messages"] = context["received_messages"][-12:]
        context["your_previous_utterances"] = context["your_previous_utterances"][-6:]
    return contexts


def lesson_contexts(output: Path, events: list[NormalizedEvent], roster: list[str]) -> dict[str, dict[str, Any]]:
    memory = output / "memory.json"
    return participant_contexts(events, roster, json.loads(memory.read_text()) if memory.exists() else None)


def create_mode_run(service: RunService, source_id: str, request: StartModeRequest, *, continue_lesson: bool = False) -> RunManifest:
    source = service.manifest(source_id)
    memory = None
    if continue_lesson:
        if (source.mode != "recorded" or source.run_configuration.get("runner") != "assessment"
                or source.run_configuration.get("status") not in {"complete", "complete_with_errors"}):
            raise ValueError("Finish the independent test before starting the next class.")
        lesson_output = service._run_dir(source.run_configuration["source_run_id"])
        memory = lesson_contexts(lesson_output, service.events(source_id),
                                 [str(source.teacher["name"]), *[student.student_id for student in source.roster]])
    known = {student.student_id for student in source.roster} | {str(source.teacher.get("name", "Teacher"))}
    if {agent.agent_id for agent in request.configuration.agents} != known:
        raise ValueError("Configuration must use this classroom's teacher and student IDs.")
    mode_steps(request.configuration)
    if request.execution == "live":
        from .provider import provider_configured
        if not provider_configured():
            raise ValueError("Save SCHOOLAGENT_API_KEY in the local .env file before starting live.")
    run_id = f"classroom-{uuid4().hex[:12]}"
    output = service.runs_root.resolve() / run_id / "visualization"
    output.mkdir(parents=True)
    architecture = request.configuration.phases[0].architecture
    manifest = source.model_copy(deep=True, update={
        "run_id": run_id, "mode": "synthetic" if request.execution == "synthetic" else "live",
        "label": f"{'Demo' if request.execution == 'synthetic' else 'Live OpenAI'} · {MODE_LABELS[architecture]}",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model_identifiers": {} if request.execution == "synthetic" else {
            key: value for key, value in json.loads((PROJECT_ROOT / "config/model.json").read_text()).items() if key.endswith("_model")
        },
        "run_configuration": {
            "lesson": source.run_configuration.get("lesson", "Bird identification"),
            "experiment": request.configuration.model_dump(), "runner": "classroom",
            "execution": request.execution, "status": "starting",
            "class_number": int(source.run_configuration.get("class_number", 1)) + 1 if continue_lesson else 1,
            **({"previous_class_run_id": source_id, "continuity": "recorded_conversation"} if continue_lesson else {}),
        },
    })
    # Only the original pre-lesson state is a starting point, never future test results.
    initial = []
    for student in source.roster:
        first = next((event for event in service.events(source_id)
                      if event.event_kind == "state_snapshot" and student.student_id in event.student_ids), None)
        if first:
            initial.append(first.model_dump())
    (output / "initial.json").write_text(json.dumps(initial), encoding="utf-8")
    if memory is not None:
        (output / "memory.json").write_text(json.dumps(memory), encoding="utf-8")
    (output / "manifest.json").write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    (output / "events.jsonl").touch()
    if request.execution == "synthetic":
        asyncio.run(execute_mode(output))
        return RunManifest.model_validate_json((output / "manifest.json").read_text())
    launch_worker(output, "agentschool_viz.mode_runs")
    return manifest


class Participant:
    def __init__(self, name: str):
        self.name = name
        self.infos: list[dict[str, Any]] = []
        self.own: list[str] = []

    def receive_broadcast_sync(self, message: dict[str, Any]) -> None:
        self.infos.append({"speaker": message["speaker"], "content": message["content"],
                           "observer_request_id": message.get("observer_request_id")})


async def execute_mode(output: Path, provider: Any = None) -> None:
    from util.BroadcastMessage import BroadcastMessage, MessageType
    from util.BroadcastSys import BroadcastSys
    from .conversations import ConversationQueue, process_conversation

    manifest_path = output / "manifest.json"
    manifest = RunManifest.model_validate_json(manifest_path.read_text())
    configuration = ExperimentConfiguration.model_validate(manifest.run_configuration["experiment"])
    phase = configuration.phases[0]
    teacher_id = str(manifest.teacher.get("name", "Teacher"))
    participants = {agent.agent_id: Participant(agent.agent_id) for agent in configuration.agents}
    if (output / "memory.json").exists():
        for name, context in json.loads((output / "memory.json").read_text()).items():
            participants[name].infos = context["received_messages"]
            participants[name].own = context["your_previous_utterances"]
    students = {student.student_id: participants[student.student_id] for student in manifest.roster}
    is_live = manifest.run_configuration["execution"] == "live"
    clock = datetime.now(timezone.utc) if is_live else datetime(2025, 9, 1, 8, tzinfo=timezone.utc)
    journal = ClassroomJournal(output, manifest.run_id, clock)
    append = journal.append
    context_request_ids: list[str] = []

    class Recorder:
        def log_sync(self, event_type: str, details: dict[str, Any]) -> None:
            with (output / "classroom.jsonl").open("a") as stream:
                stream.write(json.dumps({"event": event_type, "details": details}, default=str) + "\n")
            recipients = details["delivered_to"]
            append("interaction", {
                "speaker_id": details["speaker"], "recipient_ids": recipients, "audience_channel": details["receiver"],
                "interaction_type": "question" if details["active_event"] == "ask_question" else "explanation",
                "classification_source": "classroom action", "content": details["content"],
                "active_event": details["active_event"], "observer_request_id": details.get("observer_request_id"),
                "steering_context_ids": context_request_ids if not details.get("observer_request_id") else [],
            }, [agent for agent in [details["speaker"], *recipients] if agent in students])

    system = BroadcastSys(Recorder())
    system.enable_debug(False)
    system.set_delivery_policy(ArchitecturePolicy(configuration))
    for name, person in participants.items():
        system.subscribe(person, name)
        if name in students:
            system.subscribe(person, "student")
    system.subscribe(participants[teacher_id], "teacher")
    if phase.architecture == "pipeline":
        for person in participants.values():
            system.subscribe(person, f"artifact:{phase.artifact_name}")
    if phase.blackboard:
        for name in phase.blackboard.readers:
            system.subscribe(participants[name], "blackboard:write")
    board = Blackboard(phase.blackboard) if phase.blackboard else None
    pipeline = PipelineHistory(phase.artifact_name) if phase.artifact_name else None
    queue = ConversationQueue(output / "conversations.sqlite")
    queue.initialize()

    async def comment(person: Participant, target: str) -> str:
        text = system._strip_think_blocks(provider.speak(
            person, f"Give {target} a brief bird-identification comment; address their observations if you received any.",
        )).strip()
        person.own.append(text)
        return text

    try:
        if is_live and provider is None:
            from .provider import ClassroomProvider
            provider = ClassroomProvider(configuration, teacher_id)
        manifest.run_configuration["status"] = "running"
        write_manifest(output, manifest)
        if not is_live:
            for record in json.loads((output / "initial.json").read_text()):
                append("state_snapshot", record["payload"], record["student_ids"])
        else:
            # Authored demo mastery is not a measurement of a newly created model agent.
            for student in manifest.roster:
                append("state_snapshot", {"student_id": student.student_id, "snapshot_scope": "full",
                                         "concepts": [], "misconceptions": [], "persona": {},
                                         "evidence": "Model-agent knowledge has not been measured."}, [student.student_id])
        if manifest.run_configuration.get("continuity"):
            append("agent_action", {"agent_id": teacher_id, "role": "teacher", "phase": "teaching",
                                   "action": f"Class {manifest.run_configuration['class_number']} · continuing lesson memory"}, [])
        started = time.monotonic()
        for step in mode_steps(configuration):
            if (output / "stop.requested").exists():
                manifest.run_configuration["status"] = "stopped"
                break
            if configuration.budget.time_minutes and time.monotonic() - started >= configuration.budget.time_minutes * 60:
                manifest.run_configuration["status"] = "time_limit"
                break
            person = participants[step.author]
            if is_live:
                queue.set_ready(True)
            context_request_ids = sorted({item["observer_request_id"] for item in person.infos[-12:]
                                          if item.get("observer_request_id")})
            if board and step.author in board.permissions.readers:
                board_context = [entry.model_dump() for entry in board.read(step.author)]
            else:
                board_context = []
            instruction = step.instruction
            if board_context:
                instruction += "\nPermitted board entries: " + json.dumps(board_context)
            text = provider.speak(person, instruction) if is_live else step.demo
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Model returned no classroom dialogue.")
            text = system._strip_think_blocks(text).strip()
            if not text:
                raise ValueError("Model returned no public classroom dialogue.")
            person.own.append(text)
            if pipeline:
                artifact = pipeline.revise(step.author, text)
                with (output / "artifacts.jsonl").open("a") as stream:
                    stream.write(artifact.model_dump_json() + "\n")
                text = f"Card v{artifact.version}: {text}"
            if board:
                entry = board.write(agent_id=step.author, entry_id=step.author, kind="claim", content=text)
                with (output / "artifacts.jsonl").open("a") as stream:
                    stream.write(entry.model_dump_json() + "\n")
                text = f"Board v{entry.version}: {text}"
            system.publish_sync(step.channel, BroadcastMessage(
                current_time=journal.clock, message_type=MessageType.CLASS, active_event=step.action,
                speaker=step.author, content=text,
            ))
            if step.author == teacher_id:
                append("instructor_snapshot", {
                    "instructor_id": teacher_id, "period": "teaching", "content": text,
                    "teaching_strategy": MODE_LABELS[phase.architecture], "experience_update_recorded": False,
                    "class_number": manifest.run_configuration.get("class_number", 1),
                }, [])
            if is_live:
                await asyncio.sleep(2)
                if not (output / "stop.requested").exists():
                    context_request_ids = []
                    await process_conversation(queue, students, participants[teacher_id], system, journal.clock,
                                               assistance_allowed=True, generate=comment)
        else:
            manifest.run_configuration["status"] = "complete"
        # No authored score is copied into a fresh mode run or presented as a model outcome.
        append("agent_action", {"agent_id": teacher_id, "role": "teacher",
                                "action": "Lesson finished. No independent test has been run in this classroom session."}, [])
    except Exception as error:
        status = getattr(error, "status_code", None)
        detail = f"Classroom failed: {type(error).__name__}" + (f" (HTTP {status})" if status else "") + ". No substitute dialogue was generated."
        manifest.run_configuration.update(status="failed", error=detail)
        append("agent_action", {"agent_id": teacher_id, "role": "teacher", "action": detail}, [])
        print(detail, flush=True)
        raise RuntimeError(detail) from None
    finally:
        queue.close()
        if is_live:
            manifest.mode = "recorded"
        write_manifest(output, manifest)


if __name__ == "__main__":
    asyncio.run(execute_mode(Path(sys.argv[1])))
