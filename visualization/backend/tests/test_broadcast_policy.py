import asyncio

from util.BroadcastMessage import BroadcastMessage, MessageType
from util.BroadcastSys import BroadcastSys


class Recorder:
    def __init__(self):
        self.records = []

    async def log(self, event_type, details):
        self.records.append((event_type, details))

    def log_sync(self, event_type, details):
        self.records.append((event_type, details))


class Agent:
    def __init__(self, name):
        self.name = name
        self.received = []

    async def receive_broadcast(self, message):
        self.received.append(message)

    def receive_broadcast_sync(self, message):
        self.received.append(message)


def message():
    return BroadcastMessage(
        message_type=MessageType.CLASS,
        active_event="explanation",
        speaker="Teacher",
        content="evidence",
    )


def test_delivery_policy_blocks_before_sync_observation():
    recorder = Recorder()
    system = BroadcastSys(recorder)
    system.enable_debug(False)
    allowed = Agent("A")
    blocked = Agent("B")
    system.subscribe(allowed, "student")
    system.subscribe(blocked, "student")
    system.set_delivery_policy(lambda **context: context["target_id"] == "A")
    system.publish_sync("student", message())
    assert len(allowed.received) == 1
    assert blocked.received == []
    assert recorder.records[0][1]["delivered_to"] == ["A"]
    assert recorder.records[0][1]["blocked_to"] == ["B"]


def test_delivery_policy_blocks_before_async_observation():
    recorder = Recorder()
    system = BroadcastSys(recorder)
    system.enable_debug(False)
    allowed = Agent("A")
    blocked = Agent("B")
    system.subscribe(allowed, "student")
    system.subscribe(blocked, "student")
    system.set_delivery_policy(lambda **context: context["target_id"] == "A")
    asyncio.run(system.publish("student", message()))
    assert len(allowed.received) == 1
    assert blocked.received == []
