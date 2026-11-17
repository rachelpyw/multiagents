import asyncio
import json
import pytest
from fastapi.testclient import TestClient

from agentschool_viz import app as api
from agentschool_viz.conversations import (
    ConversationQueue, ConversationRequest, ConversationUnavailable, process_conversation, run_with_conversations,
)
from agentschool_viz.service import RunService
from agentschool_viz.instrumentation import RunCapture
from util.BroadcastSys import BroadcastSys


class Recorder:
    def __init__(self):
        self.messages = []

    def log_sync(self, event_type, details):
        self.messages.append(details)


class Agent:
    def __init__(self, name):
        self.name = name
        self.infos = []

    def receive_broadcast_sync(self, info):
        self.infos.append(info)


def setup_queue(tmp_path):
    queue = ConversationQueue(tmp_path / "conversations.sqlite")
    queue.initialize()
    queue.set_ready(True)
    receipt = queue.enqueue(ConversationRequest(source_id="A", target_id="B"))
    recorder = Recorder()
    broadcast = BroadcastSys(recorder)
    broadcast.enable_debug(False)
    students = {name: Agent(name) for name in ("A", "B")}
    teacher = Agent("Teacher")
    for student in students.values():
        broadcast.subscribe(student, student.name)
    broadcast.subscribe(teacher, "teacher")
    return queue, receipt, broadcast, students, teacher


def test_peer_exchange_reaches_next_observations_and_teacher_with_provenance(tmp_path):
    queue, receipt, broadcast, students, teacher = setup_queue(tmp_path)
    capture = RunCapture(tmp_path / "captured")
    broadcast.add_event_listener(capture.record_broadcast)

    async def generate(student, target):
        if student.name == "B":
            assert student.infos[0]["speaker"] == "A"
            assert student.infos[0]["content"] == "Compare the bill."
        return "<think>Not public</think>Compare the bill." if student.name == "A" else "I also see a neck ring."

    asyncio.run(process_conversation(
        queue, students, teacher, broadcast, "2025-09-01T08:03:00",
        assistance_allowed=True, generate=generate,
    ))
    assert queue.receipt(receipt["request_id"])["status"] == "completed"
    assert len(teacher.infos) == 2
    assert students["A"].infos[0]["speaker"] == "B"
    assert all(message["observer_request_id"] == receipt["request_id"] for message in teacher.infos)
    events = [json.loads(line) for line in capture.events_path.read_text().splitlines()]
    assert [event["payload"]["recipient_ids"] for event in events] == [["B"], ["Teacher"], ["A"], ["Teacher"]]
    assert all(event["payload"]["observer_request_id"] == receipt["request_id"] for event in events)
    assert queue.claim() is None


def test_board_steering_uses_public_permissions_not_private_route_bypass(tmp_path):
    from agentschool_viz.architecture import ArchitecturePolicy, LessonPhase, register_architecture_subscriptions
    from test_architecture import configuration

    queue, receipt, broadcast, students, teacher = setup_queue(tmp_path)
    phase = LessonPhase(phase_id="board", label="Board", architecture="blackboard",
                        blackboard={"readers": ["A", "B", "Teacher"], "writers": ["A", "B"]})
    policy = ArchitecturePolicy(configuration(phase))
    broadcast.set_delivery_policy(policy)
    register_architecture_subscriptions(broadcast, policy, {**students, "Teacher": teacher})

    async def generate(student, target):
        return f"{student.name}'s visible board contribution"

    asyncio.run(process_conversation(queue, students, teacher, broadcast, "now",
                                    assistance_allowed=True, generate=generate))
    assert queue.receipt(receipt["request_id"])["status"] == "completed"
    assert len(teacher.infos) == 2
    assert len(students["A"].infos) == len(students["B"].infos) == 1
    assert all(message["receiver"] == "blackboard:write" for message in teacher.infos)


@pytest.mark.parametrize("architecture", ["decentralized", "blackboard"])
def test_steering_dispatches_within_half_a_second_while_native_work_is_pending(tmp_path, architecture):
    from agentschool_viz.architecture import ArchitecturePolicy, LessonPhase, register_architecture_subscriptions
    from test_architecture import configuration

    queue, initial, broadcast, students, teacher = setup_queue(tmp_path)
    queue.complete(initial["request_id"], "declined", "Test setup")
    phase = LessonPhase(
        phase_id="live", label="Live", architecture=architecture,
        routes=[{"source_id": "A", "target_id": "B"}, {"source_id": "B", "target_id": "A"}],
        blackboard={"readers": ["A", "B", "Teacher"], "writers": ["A", "B"]} if architecture == "blackboard" else None,
    )
    broadcast.set_delivery_policy(ArchitecturePolicy(configuration(phase)))
    register_architecture_subscriptions(broadcast, broadcast.delivery_policy, {**students, "Teacher": teacher})

    async def exercise():
        started, release, generated = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def native_round():
            started.set()
            await release.wait()

        async def generate(student, target):
            generated.set()
            return f"{student.name}: compare its field marks."

        async def process():
            await process_conversation(queue, students, teacher, broadcast, "now",
                                       assistance_allowed=True, generate=generate)

        task = asyncio.create_task(run_with_conversations(native_round(), process))
        try:
            await started.wait()
            receipt = queue.enqueue(ConversationRequest(source_id="A", target_id="B"))
            await asyncio.wait_for(generated.wait(), timeout=.5)
            assert queue.receipt(receipt["request_id"])["status"] == "completed"
            assert not task.done()
        finally:
            release.set()
            await task

    asyncio.run(exercise())


def test_test_start_during_generation_prevents_delivery(tmp_path):
    queue, receipt, broadcast, students, teacher = setup_queue(tmp_path)

    async def generate(student, target):
        queue.set_ready(False)
        return "This must not enter the test."

    asyncio.run(process_conversation(queue, students, teacher, broadcast, "now",
                                    assistance_allowed=True, generate=generate))
    assert queue.receipt(receipt["request_id"])["status"] == "rejected"
    assert all(not student.infos for student in students.values())
    assert not teacher.infos


def test_blocking_teacher_step_does_not_delay_steering_or_write_from_another_thread(tmp_path):
    import threading
    from agentschool_viz.native_runs import publish_on_runtime_loop

    queue, initial, broadcast, students, teacher = setup_queue(tmp_path)
    queue.complete(initial["request_id"], "declined", "Test setup")

    async def exercise():
        loop = asyncio.get_running_loop()
        owner_thread = threading.get_ident()
        started, generated = asyncio.Event(), asyncio.Event()
        release = threading.Event()

        def publish(channel, message):
            assert threading.get_ident() == owner_thread
            started.set()

        def teacher_step():
            publish_on_runtime_loop(loop, publish, "class", "Teaching")
            if not release.wait(5):
                raise TimeoutError("Test did not release its teacher step.")

        async def native_round():
            await asyncio.to_thread(teacher_step)

        async def generate(student, target):
            generated.set()
            return "A short peer observation."

        async def process():
            await process_conversation(queue, students, teacher, broadcast, "now",
                                       assistance_allowed=True, generate=generate)

        task = asyncio.create_task(run_with_conversations(native_round(), process))
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            receipt = queue.enqueue(ConversationRequest(source_id="A", target_id="B"))
            await asyncio.wait_for(generated.wait(), timeout=.5)
            assert queue.receipt(receipt["request_id"])["status"] == "completed"
            assert not task.done()
        finally:
            release.set()
            await task

    asyncio.run(exercise())

@pytest.mark.parametrize("assistance_allowed", [True, False])
def test_blocked_routes_and_independent_test_never_generate_or_deliver(tmp_path, assistance_allowed):
    queue, receipt, broadcast, students, teacher = setup_queue(tmp_path)
    if assistance_allowed:
        broadcast.set_delivery_policy(lambda **context: context["target_id"] == "Teacher")

    async def must_not_generate(student, target):
        pytest.fail("A blocked request must not invoke a model")

    asyncio.run(process_conversation(
        queue, students, teacher, broadcast, "now",
        assistance_allowed=assistance_allowed, generate=must_not_generate,
    ))
    assert queue.receipt(receipt["request_id"])["status"] == "rejected"
    assert all(not student.infos for student in students.values())
    assert not teacher.infos


def test_teacher_does_not_observe_private_peer_exchange_without_route(tmp_path):
    queue, receipt, broadcast, students, teacher = setup_queue(tmp_path)
    broadcast.set_delivery_policy(lambda **context: context["target_id"] != "Teacher")

    async def generate(student, target):
        return "A visible observation."

    asyncio.run(process_conversation(
        queue, students, teacher, broadcast, "now", assistance_allowed=True, generate=generate,
    ))
    assert queue.receipt(receipt["request_id"])["status"] == "completed"
    assert not teacher.infos
    assert len(students["A"].infos) == len(students["B"].infos) == 1


def test_failures_and_silence_are_not_reported_as_success(tmp_path):
    queue, receipt, broadcast, students, teacher = setup_queue(tmp_path)

    async def fail(student, target):
        raise RuntimeError("provider unavailable")

    with pytest.raises(RuntimeError, match="provider unavailable"):
        asyncio.run(process_conversation(
            queue, students, teacher, broadcast, "now", assistance_allowed=True, generate=fail,
        ))
    assert queue.receipt(receipt["request_id"])["status"] == "failed"
    assert not queue.available()
    queue.set_ready(True)
    silent = queue.enqueue(ConversationRequest(source_id="A", target_id="B"))

    async def decline(student, target):
        return ""

    asyncio.run(process_conversation(
        queue, students, teacher, broadcast, "now", assistance_allowed=True, generate=decline,
    ))
    assert queue.receipt(silent["request_id"])["status"] == "declined"
    assert not students["A"].infos and not students["B"].infos and not teacher.infos


def test_queue_bounds_and_close_are_persistent(tmp_path):
    queue, receipt, *_ = setup_queue(tmp_path)
    with pytest.raises(ConversationUnavailable):
        queue.enqueue(ConversationRequest(source_id="A", target_id="B"))
    queue.close()
    reloaded = ConversationQueue(queue.path)
    assert not reloaded.available()
    assert reloaded.receipt(receipt["request_id"])["status"] == "rejected"
    with pytest.raises(ConversationUnavailable):
        reloaded.enqueue(ConversationRequest(source_id="A", target_id="B"))


def test_api_keeps_replays_immutable_and_accepts_only_live_roster(tmp_path, monkeypatch):
    service = RunService(tmp_path)
    original = service.manifest("synthetic-tutorial")
    known = [str(original.teacher["name"]), *(student.student_id for student in original.roster)]
    experiment = {
        "config_id": "peers", "label": "Peers", "lesson_content": "Birds",
        "agents": [{"agent_id": name, "display_name": name, "role": "agent"} for name in known],
        "phases": [{"phase_id": "board", "label": "Board", "architecture": "blackboard",
                    "blackboard": {"readers": known, "writers": known}}],
        "assessment": {"blueprint_id": "birds"},
    }
    live = original.model_copy(update={"run_id": "live-test", "mode": "live",
                                       "run_configuration": {"experiment": experiment}})
    folder = tmp_path / "live-test" / "visualization"
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text(live.model_dump_json())
    queue = ConversationQueue(folder / "conversations.sqlite")
    queue.initialize()
    queue.set_ready(True)
    monkeypatch.setattr(api, "service", service)
    client = TestClient(api.app)
    request = {"source_id": "StudentA", "target_id": "StudentB"}
    assert client.post("/api/runs/synthetic-tutorial/conversations", json=request).status_code == 409
    assert client.post("/api/runs/live-test/conversations", json={**request, "target_id": "unknown"}).status_code == 422
    response = client.post("/api/runs/live-test/conversations", json=request)
    assert response.status_code == 202
    receipt = client.get(f"/api/runs/live-test/conversations/{response.json()['request_id']}").json()
    assert receipt["status"] == "queued"
    assert service.events("synthetic-tutorial")  # The fixture remains readable and unchanged.


@pytest.mark.parametrize(("architecture", "restricted"), [
    ("supervisor", False), ("pipeline", False), ("decentralized", False),
    ("blackboard", False), ("decentralized", True), ("blackboard", True),
])
def test_api_advertises_and_queues_only_policy_permitted_peer_exchanges(tmp_path, monkeypatch, architecture, restricted):
    from test_mode_runs import classroom, request

    service, _ = classroom(tmp_path)
    configuration = request(architecture).configuration
    phase = configuration.phases[0]
    if restricted:
        if architecture == "decentralized":
            phase.routes.pop()
        else:
            phase.blackboard.writers.remove("B")
    live = service.manifest("source").model_copy(update={
        "run_id": "live-policy", "mode": "live",
        "run_configuration": {"runner": "native", "experiment": configuration.model_dump()},
    })
    folder = service.runs_root / live.run_id / "visualization"
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text(live.model_dump_json())
    queue = ConversationQueue(folder / "conversations.sqlite")
    queue.initialize()
    queue.set_ready(True)
    monkeypatch.setattr(api, "service", service)
    client = TestClient(api.app)
    enabled = architecture in {"decentralized", "blackboard"} and not restricted
    assert client.get("/api/runs/live-policy/conversations").json()["available"] is enabled
    response = client.post("/api/runs/live-policy/conversations", json={"source_id": "A", "target_id": "B"})
    assert response.status_code == (202 if enabled else 409)
    if not enabled:
        assert queue.claim() is None
