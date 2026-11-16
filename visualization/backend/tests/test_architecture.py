from agentschool_viz.architecture import (
    AgentDefinition,
    ArchitecturePolicy,
    AssessmentConfiguration,
    Blackboard,
    BlackboardPermissions,
    DirectedRoute,
    ExperimentConfiguration,
    LessonPhase,
    PipelineHistory,
)


def configuration(phase: LessonPhase) -> ExperimentConfiguration:
    return ExperimentConfiguration(
        config_id="test",
        label="Test",
        agents=[
            AgentDefinition(agent_id="Teacher", display_name="Teacher", role="teacher"),
            AgentDefinition(agent_id="A", display_name="A", role="student"),
            AgentDefinition(agent_id="B", display_name="B", role="student"),
        ],
        lesson_content="Bird identification",
        phases=[phase],
        assessment=AssessmentConfiguration(blueprint_id="fixed"),
    )


def allowed(policy: ArchitecturePolicy, source: str, target: str, channel: str = "class") -> bool:
    return policy(source_id=source, target_id=target, channel=channel, message=None)


def test_supervisor_blocks_peer_delivery_without_explicit_permission():
    phase = LessonPhase(
        phase_id="supervisor",
        label="Supervisor",
        architecture="supervisor",
        coordinator_id="Teacher",
    )
    policy = ArchitecturePolicy(configuration(phase))
    assert allowed(policy, "Teacher", "A")
    assert allowed(policy, "A", "Teacher")
    assert not allowed(policy, "A", "B")


def test_decentralized_removed_route_prevents_delivery():
    phase = LessonPhase(
        phase_id="network",
        label="Network",
        architecture="decentralized",
        routes=[DirectedRoute(source_id="A", target_id="B")],
    )
    policy = ArchitecturePolicy(configuration(phase))
    assert allowed(policy, "A", "B")
    phase.routes = []
    assert not ArchitecturePolicy(configuration(phase))(
        source_id="A", target_id="B", channel="class", message=None
    )


def test_pipeline_only_passes_named_artifact_to_next_agent():
    phase = LessonPhase(
        phase_id="pipeline",
        label="Pipeline",
        architecture="pipeline",
        pipeline_order=["Teacher", "A", "B"],
        artifact_name="evidence-card",
        speaking_policy="ordered",
    )
    policy = ArchitecturePolicy(configuration(phase))
    assert allowed(policy, "Teacher", "A", "artifact:evidence-card")
    assert not allowed(policy, "Teacher", "B", "artifact:evidence-card")
    assert not allowed(policy, "Teacher", "A", "class")
    history = PipelineHistory("evidence-card")
    assert history.revise("Teacher", "bill").version == 1
    assert history.revise("A", "bill and tail").previous_version == 1


def test_blackboard_permissions_and_versions():
    permissions = BlackboardPermissions(readers=["Teacher", "A", "B"], writers=["Teacher", "A"])
    board = Blackboard(permissions)
    first = board.write(agent_id="A", entry_id="claim", kind="claim", content="mallard")
    second = board.write(agent_id="Teacher", entry_id="claim", kind="evidence", content="male mallard")
    assert first.version == 1
    assert second.version == 2
    assert [entry.version for entry in board.history("claim")] == [1, 2]
    try:
        board.write(agent_id="B", entry_id="claim", kind="claim", content="teal")
    except PermissionError:
        pass
    else:
        raise AssertionError("read-only agent wrote to blackboard")
