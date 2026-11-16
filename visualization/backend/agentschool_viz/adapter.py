from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .schemas import InteractionPayload, NormalizedEvent, SourceRecordRef


@dataclass(frozen=True)
class ParsedLine:
    line_number: int
    value: dict[str, Any]


def read_jsonl(path: Path) -> Iterable[ParsedLine]:
    if not path.exists():
        return
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.endswith("\n"):
                continue
            try:
                value = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(value, dict):
                yield ParsedLine(line_number, value)


def stable_event_id(run_id: str, source_path: str, line: int, record: dict[str, Any]) -> str:
    digest = hashlib.sha256(
        json.dumps(record, ensure_ascii=False, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]
    return f"{run_id}:{source_path}:{line}:{digest}"


def classify_interaction(details: dict[str, Any]) -> tuple[str, str]:
    active_event = str(details.get("active_event") or "").lower()
    explicit = {
        "answer": "explanation",
        "explanation": "explanation",
        "lecture": "explanation",
        "group_discussion_feedback": "explanation",
        "question": "question",
        "ask_question": "question",
        "help_request": "help_request",
        "request_help": "help_request",
    }
    if active_event in explicit:
        return explicit[active_event], f"native active_event={active_event}"

    content = str(details.get("content") or "").strip().lower()
    if content.endswith("?") or content.endswith("？"):
        return "question", "derived: terminal question mark"
    help_markers = ("help me", "need help", "can someone help", "请帮", "需要帮助")
    if any(marker in content for marker in help_markers):
        return "help_request", "derived: documented help phrase"
    return "other", "derived: no deterministic classification matched"


def normalize_broadcast(
    *,
    record: dict[str, Any],
    run_id: str,
    sequence: int,
    roster: set[str],
    source_path: str,
    source_line: int,
) -> NormalizedEvent | None:
    if record.get("event") != "broadcast" or not isinstance(record.get("details"), dict):
        return None
    details = record["details"]
    speaker = str(details.get("speaker") or "unknown")
    receiver = str(details.get("receiver") or "unknown")
    interaction_type, classification_source = classify_interaction(details)
    delivered = details.get("delivered_to")
    recipients = (
        sorted({str(agent_id) for agent_id in delivered})
        if isinstance(delivered, list)
        else ([receiver] if receiver in roster else None)
    )
    audience = None if recipients else receiver
    payload = InteractionPayload(
        speaker_id=speaker,
        recipient_ids=recipients,
        audience_channel=audience,
        interaction_type=interaction_type,
        classification_source=classification_source,
        content=str(details.get("content") or ""),
        active_event=str(details.get("active_event") or "") or None,
        observer_request_id=details.get("observer_request_id"),
        steering_context_ids=details.get("steering_context_ids") or [],
    )
    event_id = stable_event_id(run_id, source_path, source_line, record)
    student_ids = sorted({person for person in [speaker, *(recipients or [])] if person in roster})
    return NormalizedEvent(
        run_id=run_id,
        event_id=event_id,
        sequence=sequence,
        simulation_time=str(details.get("current_time") or record.get("time") or ""),
        event_kind="interaction",
        student_ids=student_ids,
        source_record_refs=[SourceRecordRef(path=source_path, line=source_line)],
        payload=payload.model_dump(),
    )


def normalize_native_run(run_dir: Path, run_id: str, roster: set[str]) -> list[NormalizedEvent]:
    events: list[NormalizedEvent] = []
    files = sorted(run_dir.glob("*/broadcast_log.jsonl"))
    seen: set[str] = set()
    for path in files:
        source_path = str(path.relative_to(run_dir))
        for parsed in read_jsonl(path):
            event = normalize_broadcast(
                record=parsed.value,
                run_id=run_id,
                sequence=len(events),
                roster=roster,
                source_path=source_path,
                source_line=parsed.line_number,
            )
            if event and event.event_id not in seen:
                seen.add(event.event_id)
                events.append(event)
    events.sort(key=lambda event: (event.simulation_time, event.sequence, event.event_id))
    return [event.model_copy(update={"sequence": index}) for index, event in enumerate(events)]
