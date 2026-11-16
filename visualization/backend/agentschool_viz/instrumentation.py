from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from .adapter import classify_interaction
from .schemas import (
    ConceptValue,
    AgentActionPayload,
    InstructorSnapshotPayload,
    InteractionPayload,
    MisconceptionRecord,
    NormalizedEvent,
    RunManifest,
    SourceRecordRef,
    StateChangePayload,
    StateSnapshotPayload,
    StudentManifest,
)

STUDENT_COLORS = ["#3778a8", "#c47b32", "#7666a9", "#4f8a70", "#b85d6b", "#68788c"]

def require_english_public_text(value: Any) -> None:
    if os.getenv("AGENTSCHOOL_OUTPUT_LANGUAGE") != "en":
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"content", "action", "text", "label", "target", "retrieved_experience", "evidence", "note"}:
                if isinstance(item, str) and re.search(r"[\u3400-\u9fff]", item):
                    raise ValueError(f"Native output contained non-English prose in {key}; it was not published.")
            require_english_public_text(item)
    elif isinstance(value, list):
        for item in value:
            require_english_public_text(item)


def _read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def _upstream_commit(root: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "upstream/main"], cwd=root, text=True
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


class RunCapture:
    def __init__(self, run_dir: str | Path, project_root: str | Path = "."):
        self.run_dir = Path(run_dir)
        self.project_root = Path(project_root).resolve()
        self.output_dir = self.run_dir / "visualization"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.events_path = self.output_dir / "events.jsonl"
        self.sequence = 0
        self.last_snapshot: dict[str, dict[str, Any]] = {}
        self.recent_interactions: list[str] = []
        self.current_simulation_time = ""
        self.run_id = self.run_dir.name
        configs = sorted((self.project_root / "config/student").glob("*.json"))
        self.student_configs = [_read_json(path) for path in configs]
        self.roster = {str(config["name"]) for config in self.student_configs}
        self.student_state_paths = {
            str(config["name"]): f"{config['folder']}/nodes.json"
            for config in self.student_configs
        }
        self._write_manifest()

    def _write_manifest(self) -> None:
        teacher = _read_json(self.project_root / "config/teacher.json")
        schedule = _read_json(self.project_root / "config/schedule.json")
        models = _read_json(self.project_root / "config/model.json")
        roster = []
        for index, config in enumerate(self.student_configs):
            name = str(config["name"])
            roster.append(
                StudentManifest(
                    student_id=name,
                    display_name=name,
                    color=STUDENT_COLORS[index % len(STUDENT_COLORS)],
                    initials="".join(part[:1] for part in name.split())[:2].upper(),
                    attributes={
                        key: config.get(key)
                        for key in (
                            "age",
                            "gender",
                            "grade",
                            "personality",
                            "MBTI",
                            "attention_level",
                            "stress",
                            "cognitive_state",
                            "affective_state",
                            "learning_style",
                            "common_mistakes",
                            "group",
                            "retention",
                        )
                    },
                )
            )
        manifest = RunManifest(
            run_id=self.run_id,
            mode="live",
            label=f"AgentSchool run {self.run_id}",
            created_at=datetime.now().isoformat(),
            upstream_commit=_upstream_commit(self.project_root),
            roster=roster,
            teacher={
                key: teacher.get(key)
                for key in (
                    "name",
                    "subject",
                    "experience_level",
                    "pck_level",
                    "overall_target",
                    "teaching_strategy_template",
                    "teaching_strategy",
                )
            },
            model_identifiers={key: value for key, value in models.items() if key.endswith("_model")},
            run_configuration={"schedule": schedule},
        )
        (self.output_dir / "manifest.json").write_text(
            manifest.model_dump_json(indent=2), encoding="utf-8"
        )

    def _append(self, event: NormalizedEvent) -> None:
        require_english_public_text(event.payload)
        with self.events_path.open("a", encoding="utf-8") as stream:
            stream.write(event.model_dump_json() + "\n")
        self.sequence += 1

    def record_broadcast(self, details: dict[str, Any]) -> None:
        speaker = str(details.get("speaker") or "unknown")
        receiver = str(details.get("receiver") or "unknown")
        recipients = [receiver] if receiver in self.roster else None
        if "delivered_to" in details:
            recipients = [str(person) for person in details["delivered_to"]]
        interaction_type, source = classify_interaction(details)
        event_id = f"{self.run_id}:broadcast:{self.sequence}"
        payload = InteractionPayload(
            speaker_id=speaker,
            recipient_ids=recipients,
            audience_channel=receiver,
            interaction_type=interaction_type,
            classification_source=source,
            content=str(details.get("content") or ""),
            active_event=str(details.get("active_event") or "") or None,
            observer_request_id=details.get("observer_request_id"),
            steering_context_ids=details.get("steering_context_ids") or [],
        )
        self._append(
            NormalizedEvent(
                run_id=self.run_id,
                event_id=event_id,
                sequence=self.sequence,
                simulation_time=str(details.get("current_time") or self.current_simulation_time),
                event_kind="interaction",
                student_ids=sorted(
                    {person for person in [speaker, *(recipients or [])] if person in self.roster}
                ),
                source_record_refs=[SourceRecordRef(path="broadcast_log.jsonl", hook="BroadcastSys")],
                payload=payload.model_dump(),
            )
        )
        self.recent_interactions.append(event_id)

    def record_students(self, students: dict[str, Any], simulation_time: Any, scope: str = "full") -> None:
        self.current_simulation_time = str(simulation_time)
        context_ids = self.recent_interactions[:]
        self.recent_interactions.clear()
        for student_id, student in students.items():
            current = self._extract_student(student)
            previous = self.last_snapshot.get(student_id)
            snapshot = StateSnapshotPayload(
                student_id=student_id,
                snapshot_scope=scope,
                concepts=current["concepts"],
                misconceptions=current["misconceptions"],
                persona=current["persona"],
                evidence="Native knowledge graph and memory state",
            )
            snapshot_id = f"{self.run_id}:snapshot:{self.sequence}"
            self._append(
                NormalizedEvent(
                    run_id=self.run_id,
                    event_id=snapshot_id,
                    sequence=self.sequence,
                    simulation_time=str(simulation_time),
                    event_kind="state_snapshot",
                    student_ids=[student_id],
                    source_record_refs=[
                        SourceRecordRef(
                            path=self.student_state_paths[student_id],
                            hook="RunCapture",
                        )
                    ],
                    payload=snapshot.model_dump(),
                )
            )
            if previous is not None:
                self._record_changes(student_id, previous, current, simulation_time, context_ids)
            self.last_snapshot[student_id] = current

    def record_teacher(self, teacher: Any, simulation_time: Any, action: Any = None, *, experience_updated: bool = False) -> None:
        teacher_id = str(getattr(teacher, "name", "Teacher"))
        if action:
            payload = AgentActionPayload(
                agent_id=teacher_id,
                role="teacher",
                action=str(action),
            )
            self._append(
                NormalizedEvent(
                    run_id=self.run_id,
                    event_id=f"{self.run_id}:teacher-action:{self.sequence}",
                    sequence=self.sequence,
                    simulation_time=str(simulation_time),
                    event_kind="agent_action",
                    student_ids=[],
                    source_record_refs=[SourceRecordRef(path="action_log.jsonl", hook="RunCapture")],
                    payload=payload.model_dump(),
                )
            )
        snapshot = InstructorSnapshotPayload(
            instructor_id=teacher_id,
            period=getattr(teacher, "period", None),
            current_turn=getattr(teacher, "current_turn", None),
            class_turns=getattr(teacher, "class_turns", None),
            class_number=getattr(teacher, "class_number", None),
            content=getattr(teacher, "content", None),
            target=getattr(teacher, "target", None),
            retrieved_experience=getattr(teacher, "experience", None) or None,
            teaching_strategy=getattr(teacher, "teaching_strategy", None),
            experience_update_recorded=experience_updated,
        )
        self._append(
            NormalizedEvent(
                run_id=self.run_id,
                event_id=f"{self.run_id}:teacher-snapshot:{self.sequence}",
                sequence=self.sequence,
                simulation_time=str(simulation_time),
                event_kind="instructor_snapshot",
                student_ids=[],
                source_record_refs=[SourceRecordRef(path="teacher status", hook="RunCapture")],
                payload=snapshot.model_dump(),
            )
        )

    def record_student_action(self, student_id: str, simulation_time: Any, action: Any) -> None:
        if not action:
            return
        payload = AgentActionPayload(
            agent_id=student_id,
            role="student",
            action=str(action),
        )
        self._append(
            NormalizedEvent(
                run_id=self.run_id,
                event_id=f"{self.run_id}:student-action:{self.sequence}",
                sequence=self.sequence,
                simulation_time=str(simulation_time),
                event_kind="agent_action",
                student_ids=[student_id],
                source_record_refs=[SourceRecordRef(path="action_log.jsonl", hook="RunCapture")],
                payload=payload.model_dump(),
            )
        )

    def _extract_student(self, student: Any) -> dict[str, Any]:
        from student.knowledge_graph import kg

        concepts = [
            ConceptValue(
                concept_id=concept_id,
                label=record.concept_name,
                raw_value=record.p,
                raw_unit="probability (0..1)",
                normalized_mastery=record.p * 100,
                mapping="raw probability × 100",
            )
            for (owner, concept_id), record in kg.mastery.items()
            if owner == student.name
        ]
        misconceptions: list[MisconceptionRecord] = []
        for node in student.mem.seq_knowledge:
            recorded = node.misconceptions
            for text in ([recorded] if isinstance(recorded, str) else recorded or []):
                stable = hashlib.sha256(
                    f"{student.name}|{node.knowledge_tag}|{text}".encode()
                ).hexdigest()[:12]
                misconceptions.append(
                    MisconceptionRecord(
                        misconception_id=stable,
                        concept_id=(node.knowledge_tag or [None])[0],
                        text=str(text),
                        status="unknown",
                    )
                )
        persona = {
            key: getattr(student.scratch, key, None)
            for key in (
                "age",
                "gender",
                "grade",
                "personality",
                "MBTI",
                "attention_level",
                "stress",
                "cognitive_state",
                "affective_state",
                "learning_style",
                "common_mistakes",
                "group",
                "retention",
            )
        }
        return {
            "concepts": [value.model_dump() for value in concepts],
            "misconceptions": [value.model_dump() for value in misconceptions],
            "persona": persona,
        }

    def _record_changes(
        self,
        student_id: str,
        previous: dict[str, Any],
        current: dict[str, Any],
        simulation_time: Any,
        context_ids: list[str],
    ) -> None:
        old_concepts = {item["concept_id"]: item for item in previous["concepts"]}
        for concept in current["concepts"]:
            before = old_concepts.get(concept["concept_id"])
            if before != concept:
                payload = StateChangePayload(
                    student_id=student_id,
                    concept_id=concept["concept_id"],
                    before=before,
                    after=concept,
                    source_event_ids=context_ids,
                    attribution="context_only",
                    note="State update recorded after this round",
                )
                self._append_change(student_id, simulation_time, payload)

        old_misconceptions = {
            item["misconception_id"]: item for item in previous["misconceptions"]
        }
        for misconception in current["misconceptions"]:
            before = old_misconceptions.get(misconception["misconception_id"])
            if before is None:
                payload = StateChangePayload(
                    student_id=student_id,
                    misconception_id=misconception["misconception_id"],
                    before=None,
                    after=misconception,
                    source_event_ids=context_ids,
                    attribution="context_only",
                    note="Native records do not explicitly resolve disappearing misconceptions",
                )
                self._append_change(student_id, simulation_time, payload)

    def _append_change(
        self, student_id: str, simulation_time: Any, payload: StateChangePayload
    ) -> None:
        self._append(
            NormalizedEvent(
                run_id=self.run_id,
                event_id=f"{self.run_id}:change:{self.sequence}",
                sequence=self.sequence,
                simulation_time=str(simulation_time),
                event_kind="state_change",
                student_ids=[student_id],
                source_record_refs=[SourceRecordRef(path="student state", hook="RunCapture")],
                payload=payload.model_dump(),
            )
        )

    def finish(self) -> None:
        path = self.output_dir / "manifest.json"
        manifest = RunManifest.model_validate_json(path.read_text(encoding="utf-8"))
        completed = manifest.model_copy(
            update={"mode": "recorded", "label": f"Recorded AgentSchool run {self.run_id}"}
        )
        path.write_text(completed.model_dump_json(indent=2), encoding="utf-8")
