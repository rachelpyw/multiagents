from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


ArchitectureKind = Literal["supervisor", "pipeline", "decentralized", "blackboard"]


class AgentDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent_id: str
    display_name: str
    role: str
    objective: str = ""
    allowed_actions: list[str] = Field(default_factory=list)
    observable_resources: list[str] = Field(default_factory=list)


class DirectedRoute(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: str
    target_id: str
    channel: str = "class"
    allowed: bool = True


class BlackboardPermissions(BaseModel):
    readers: list[str] = Field(default_factory=list)
    writers: list[str] = Field(default_factory=list)
    teacher_review_required: bool = False


class LessonPhase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phase_id: str
    label: str
    architecture: ArchitectureKind
    rounds: int = Field(default=1, ge=1)
    speaking_policy: Literal["coordinator", "ordered", "round_robin", "open"] = "open"
    coordinator_id: str | None = None
    peer_communication: bool = False
    pipeline_order: list[str] = Field(default_factory=list)
    artifact_name: str | None = None
    routes: list[DirectedRoute] = Field(default_factory=list)
    blackboard: BlackboardPermissions | None = None


class ResourceBudget(BaseModel):
    time_minutes: int | None = Field(default=None, ge=1)
    max_turns: int | None = Field(default=None, ge=1)
    max_messages: int | None = Field(default=None, ge=1)
    max_tokens: int | None = Field(default=None, ge=1)


class AssessmentConfiguration(BaseModel):
    blueprint_id: str
    fixed_items: bool = True
    independent: bool = True
    assistance_disabled: bool = True


class ExperimentConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config_id: str
    label: str
    status: Literal["preset", "custom"] = "custom"
    agents: list[AgentDefinition]
    lesson_content: str
    resources: list[str] = Field(default_factory=list)
    shared_artifacts: list[str] = Field(default_factory=list)
    phases: list[LessonPhase]
    budget: ResourceBudget = Field(default_factory=ResourceBudget)
    assessment: AssessmentConfiguration

    @model_validator(mode="after")
    def validate_references(self) -> "ExperimentConfiguration":
        agent_ids = [agent.agent_id for agent in self.agents]
        if len(agent_ids) != len(set(agent_ids)):
            raise ValueError("agent IDs must be unique")
        known = set(agent_ids)
        phase_ids: set[str] = set()
        for phase in self.phases:
            if phase.phase_id in phase_ids:
                raise ValueError("phase IDs must be unique")
            phase_ids.add(phase.phase_id)
            referenced = {
                route.source_id for route in phase.routes
            } | {
                route.target_id for route in phase.routes
            } | set(phase.pipeline_order)
            if phase.coordinator_id:
                referenced.add(phase.coordinator_id)
            if phase.blackboard:
                referenced.update(phase.blackboard.readers)
                referenced.update(phase.blackboard.writers)
            unknown = referenced - known
            if unknown:
                raise ValueError(f"phase {phase.phase_id} references unknown agents: {sorted(unknown)}")
            if phase.architecture == "supervisor" and not phase.coordinator_id:
                raise ValueError("supervisor phase requires coordinator_id")
            if phase.architecture == "pipeline":
                if len(phase.pipeline_order) < 2 or len(phase.pipeline_order) != len(set(phase.pipeline_order)):
                    raise ValueError("pipeline phase requires at least two unique ordered agents")
                if not phase.artifact_name:
                    raise ValueError("pipeline phase requires artifact_name")
            if phase.architecture == "blackboard" and not phase.blackboard:
                raise ValueError("blackboard phase requires permissions")
        return self


class ArchitecturePolicy:
    def __init__(self, configuration: ExperimentConfiguration, phase_id: str | None = None):
        self.configuration = configuration
        self.phase = next(
            (phase for phase in configuration.phases if phase.phase_id == phase_id),
            configuration.phases[0],
        )

    def __call__(
        self,
        *,
        source_id: str,
        target_id: str,
        channel: str,
        message: Any,
    ) -> bool:
        if source_id == target_id:
            return False
        phase = self.phase
        effective_channel = channel if ":" in channel else "class"
        explicit = any(
            route.allowed
            and route.source_id == source_id
            and route.target_id == target_id
            and route.channel == effective_channel
            for route in phase.routes
        )
        if phase.architecture == "supervisor":
            return (
                source_id == phase.coordinator_id
                or target_id == phase.coordinator_id
                or (phase.peer_communication and explicit)
            )
        if phase.architecture == "pipeline":
            if effective_channel != f"artifact:{phase.artifact_name}":
                return False
            pairs = set(zip(phase.pipeline_order, phase.pipeline_order[1:]))
            return (source_id, target_id) in pairs
        if phase.architecture == "decentralized":
            return explicit
        if phase.architecture == "blackboard":
            permissions = phase.blackboard
            if effective_channel == "blackboard:write":
                return bool(permissions and source_id in permissions.writers and target_id in permissions.readers)
            if effective_channel == "blackboard:read":
                return bool(permissions and source_id in permissions.readers and target_id in permissions.readers)
            return explicit
        return False


class BlackboardEntry(BaseModel):
    entry_id: str
    author_id: str
    kind: Literal["claim", "evidence", "question", "alternative"]
    content: str
    version: int = Field(ge=1)
    previous_version: int | None = None


class Blackboard:
    def __init__(self, permissions: BlackboardPermissions):
        self.permissions = permissions
        self.entries: dict[str, list[BlackboardEntry]] = {}

    def read(self, agent_id: str) -> list[BlackboardEntry]:
        if agent_id not in self.permissions.readers:
            raise PermissionError(f"{agent_id} cannot read the blackboard")
        return [versions[-1] for versions in self.entries.values()]

    def write(
        self,
        *,
        agent_id: str,
        entry_id: str,
        kind: Literal["claim", "evidence", "question", "alternative"],
        content: str,
    ) -> BlackboardEntry:
        if agent_id not in self.permissions.writers:
            raise PermissionError(f"{agent_id} cannot write to the blackboard")
        history = self.entries.setdefault(entry_id, [])
        entry = BlackboardEntry(
            entry_id=entry_id,
            author_id=agent_id,
            kind=kind,
            content=content,
            version=len(history) + 1,
            previous_version=len(history) or None,
        )
        history.append(entry)
        return entry

    def history(self, entry_id: str) -> list[BlackboardEntry]:
        return list(self.entries.get(entry_id, []))


class PipelineArtifact(BaseModel):
    artifact_name: str
    author_id: str
    content: str
    version: int = Field(ge=1)
    previous_version: int | None = None


class PipelineHistory:
    def __init__(self, artifact_name: str):
        self.artifact_name = artifact_name
        self.versions: list[PipelineArtifact] = []

    def revise(self, author_id: str, content: str) -> PipelineArtifact:
        artifact = PipelineArtifact(
            artifact_name=self.artifact_name,
            author_id=author_id,
            content=content,
            version=len(self.versions) + 1,
            previous_version=len(self.versions) or None,
        )
        self.versions.append(artifact)
        return artifact


def load_experiment_policy(path: str | Path) -> ArchitecturePolicy:
    configuration = ExperimentConfiguration.model_validate_json(
        Path(path).read_text(encoding="utf-8"),
    )
    return ArchitecturePolicy(configuration)


def register_architecture_subscriptions(
    broadcast_system: Any,
    policy: ArchitecturePolicy,
    agents: dict[str, Any],
) -> None:
    phase = policy.phase
    if phase.architecture == "pipeline" and phase.artifact_name:
        channel = f"artifact:{phase.artifact_name}"
        for agent_id in phase.pipeline_order:
            if agent_id in agents:
                broadcast_system.subscribe(agents[agent_id], channel)
    if phase.architecture == "blackboard" and phase.blackboard:
        for agent_id in phase.blackboard.readers:
            if agent_id in agents:
                broadcast_system.subscribe(agents[agent_id], "blackboard:write")
                broadcast_system.subscribe(agents[agent_id], "blackboard:read")


def configuration_schema() -> dict[str, Any]:
    return json.loads(json.dumps(ExperimentConfiguration.model_json_schema()))
