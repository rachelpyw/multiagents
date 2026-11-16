from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import SCHEMA_VERSION


class SourceRecordRef(BaseModel):
    path: str
    line: int | None = None
    hook: str | None = None


class ConceptValue(BaseModel):
    concept_id: str
    label: str
    raw_value: float | str | None = None
    raw_unit: str | None = None
    normalized_mastery: float | None = Field(default=None, ge=0, le=100)
    mapping: str | None = None
    evidence: str | None = None


class MisconceptionRecord(BaseModel):
    misconception_id: str
    concept_id: str | None = None
    text: str
    status: Literal["active", "resolved", "unknown"] = "unknown"


class InteractionPayload(BaseModel):
    speaker_id: str
    recipient_ids: list[str] | None = None
    audience_channel: str | None = None
    interaction_type: Literal["explanation", "question", "help_request", "other"]
    classification_source: str
    content: str
    concept_ids: list[str] = Field(default_factory=list)
    active_event: str | None = None
    lesson_image_url: str | None = None
    lesson_image_alt: str | None = None
    observer_request_id: str | None = None
    steering_context_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_audience(self) -> "InteractionPayload":
        if not self.recipient_ids and not self.audience_channel:
            raise ValueError("interaction requires recipient_ids or audience_channel")
        return self


class StateSnapshotPayload(BaseModel):
    student_id: str
    snapshot_scope: Literal["full", "partial"]
    concepts: list[ConceptValue] = Field(default_factory=list)
    misconceptions: list[MisconceptionRecord] = Field(default_factory=list)
    persona: dict[str, Any] = Field(default_factory=dict)
    evidence: str | None = None


class StateChangePayload(BaseModel):
    student_id: str
    concept_id: str | None = None
    misconception_id: str | None = None
    before: Any = None
    after: Any = None
    source_event_ids: list[str] = Field(default_factory=list)
    attribution: Literal["explicit", "context_only"]
    note: str | None = None

    @model_validator(mode="after")
    def require_subject(self) -> "StateChangePayload":
        if not self.concept_id and not self.misconception_id:
            raise ValueError("state change requires a concept or misconception")
        return self


class ItemResult(BaseModel):
    item_id: str
    status: Literal["correct", "wrong", "error", "missing"]
    response: str | None = None
    error: str | None = None
    label: str | None = None
    prompt: str | None = None
    task_type: Literal["classification", "recall", "other"] = "other"
    image_url: str | None = None
    image_alt: str | None = None
    expected_response: str | None = None


class AssessmentPayload(BaseModel):
    student_id: str
    assessment_id: str
    checkpoint: str
    assessment_mode: Literal["independent", "assisted_practice"]
    item_results: list[ItemResult]
    correct_count: int = Field(ge=0)
    scorable_count: int = Field(ge=0)
    attempted_count: int = Field(ge=0)
    expected_count: int = Field(ge=0)
    score_percent: float | None = Field(default=None, ge=0, le=100)
    test_timing: Literal["unspecified", "pre_lesson", "immediate", "delayed"] = "unspecified"
    retention_delay_seconds: float | None = Field(default=None, gt=0)


class AgentActionPayload(BaseModel):
    agent_id: str
    role: Literal["teacher", "student"]
    action: str
    phase: str | None = None
    endpoint: str | None = None
    status: str | None = None
    steering_context_ids: list[str] = Field(default_factory=list)


class InstructorSnapshotPayload(BaseModel):
    instructor_id: str
    period: str | None = None
    current_turn: int | None = None
    class_turns: int | None = None
    class_number: int | None = None
    content: str | None = None
    target: str | None = None
    retrieved_experience: str | None = None
    teaching_strategy: str | None = None
    experience_update_recorded: bool = False


Payload = (
    InteractionPayload
    | StateSnapshotPayload
    | StateChangePayload
    | AssessmentPayload
    | AgentActionPayload
    | InstructorSnapshotPayload
)


class NormalizedEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"] = SCHEMA_VERSION
    run_id: str
    event_id: str
    sequence: int = Field(ge=0)
    simulation_time: str
    event_kind: Literal[
        "interaction",
        "state_snapshot",
        "state_change",
        "assessment",
        "agent_action",
        "instructor_snapshot",
    ]
    student_ids: list[str] = Field(default_factory=list)
    source_record_refs: list[SourceRecordRef]
    payload: dict[str, Any]

    @model_validator(mode="after")
    def validate_payload(self) -> "NormalizedEvent":
        payload_types: dict[str, type[BaseModel]] = {
            "interaction": InteractionPayload,
            "state_snapshot": StateSnapshotPayload,
            "state_change": StateChangePayload,
            "assessment": AssessmentPayload,
            "agent_action": AgentActionPayload,
            "instructor_snapshot": InstructorSnapshotPayload,
        }
        payload_types[self.event_kind].model_validate(self.payload)
        return self


class StudentManifest(BaseModel):
    student_id: str
    display_name: str
    color: str
    initials: str
    attributes: dict[str, Any] = Field(default_factory=dict)


class RunManifest(BaseModel):
    schema_version: Literal["1.0"] = SCHEMA_VERSION
    run_id: str
    mode: Literal["recorded", "live", "synthetic"]
    label: str
    created_at: str
    upstream_commit: str
    roster: list[StudentManifest]
    teacher: dict[str, Any]
    concept_mapping: dict[str, str] = Field(default_factory=dict)
    model_identifiers: dict[str, str] = Field(default_factory=dict)
    assessment_definitions: list[dict[str, Any]] = Field(default_factory=list)
    run_configuration: dict[str, Any] = Field(default_factory=dict)
