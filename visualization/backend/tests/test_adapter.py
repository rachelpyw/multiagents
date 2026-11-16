import json
from pathlib import Path

from agentschool_viz.adapter import normalize_broadcast, read_jsonl


def test_broadcast_channel_is_not_fabricated_as_student():
    event = normalize_broadcast(
        record={
            "time": "2025-09-01T08:00:00",
            "event": "broadcast",
            "details": {
                "speaker": "Teacher",
                "receiver": "student",
                "content": "What happens next?",
                "active_event": "question",
            },
        },
        run_id="run",
        sequence=0,
        roster={"StudentA"},
        source_path="1/broadcast_log.jsonl",
        source_line=1,
    )
    assert event is not None
    assert event.payload["recipient_ids"] is None
    assert event.payload["audience_channel"] == "student"


def test_partial_line_and_duplicate_content_are_handled(tmp_path: Path):
    path = tmp_path / "events.jsonl"
    valid = {"event": "broadcast", "details": {}}
    path.write_text(json.dumps(valid) + "\n" + '{"partial":', encoding="utf-8")
    assert [line.value for line in read_jsonl(path)] == [valid]


def test_observer_request_and_confirmed_teacher_delivery_survive_import():
    event = normalize_broadcast(
        record={"event": "broadcast", "time": "now", "details": {
            "speaker": "StudentA", "receiver": "teacher", "delivered_to": ["Teacher"],
            "content": "Compare the bill.", "observer_request_id": "request-1",
            "steering_context_ids": ["previous-request"],
        }},
        run_id="run", sequence=0, roster={"StudentA"},
        source_path="broadcast_log.jsonl", source_line=1,
    )
    assert event.payload["recipient_ids"] == ["Teacher"]
    assert event.payload["observer_request_id"] == "request-1"
    assert event.payload["steering_context_ids"] == ["previous-request"]
