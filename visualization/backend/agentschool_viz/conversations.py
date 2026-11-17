from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from pydantic import BaseModel, Field


class ConversationRequest(BaseModel):
    source_id: str = Field(min_length=1, max_length=128)
    target_id: str = Field(min_length=1, max_length=128)


class ConversationUnavailable(ValueError):
    pass


class ConversationQueue:
    """Local cross-process queue shared by the API and the owning run."""

    def __init__(self, path: Path):
        self.path = path

    def initialize(self) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY, ready INTEGER, updated REAL)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS requests "
                "(id TEXT PRIMARY KEY, source TEXT, target TEXT, status TEXT, detail TEXT, created REAL)"
            )
        self.set_ready(False)

    def set_ready(self, ready: bool) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT OR REPLACE INTO runtime VALUES (1, ?, ?)", (int(ready), time.time()))

    def available(self) -> bool:
        if not self.path.exists():
            return False
        with sqlite3.connect(self.path) as db:
            row = db.execute("SELECT ready, updated FROM runtime WHERE id = 1").fetchone()
        return bool(row and row[0] and time.time() - row[1] < 300)

    def enqueue(self, request: ConversationRequest) -> dict[str, Any]:
        if not self.available():
            raise ConversationUnavailable("Live conversation input is unavailable in this run or lesson phase.")
        request_id = str(uuid4())
        with sqlite3.connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM requests WHERE status IN ('queued', 'processing')").fetchone():
                raise ConversationUnavailable("A conversation is already queued or being generated.")
            db.execute(
                "INSERT INTO requests VALUES (?, ?, ?, 'queued', ?, ?)",
                (request_id, request.source_id, request.target_id, "Waiting for the live conversation dispatcher.", time.time()),
            )
        return self.receipt(request_id)

    def receipt(self, request_id: str) -> dict[str, Any]:
        with sqlite3.connect(self.path) as db:
            row = db.execute(
                "SELECT id, source, target, status, detail FROM requests WHERE id = ?", (request_id,),
            ).fetchone()
        if row is None:
            raise KeyError(request_id)
        return dict(zip(("request_id", "source_id", "target_id", "status", "detail"), row))

    def claim(self) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id FROM requests WHERE status = 'queued' ORDER BY created LIMIT 1").fetchone()
            if row is None:
                return None
            db.execute("UPDATE requests SET status = 'processing', detail = 'Generating peer dialogue.' WHERE id = ?", row)
        return self.receipt(row[0])

    def complete(self, request_id: str, status: str, detail: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE requests SET status = ?, detail = ? WHERE id = ?", (status, detail, request_id))

    def close(self) -> None:
        self.set_ready(False)
        with sqlite3.connect(self.path) as db:
            db.execute(
                "UPDATE requests SET status = 'rejected', detail = 'Run ended before this request completed.' "
                "WHERE status IN ('queued', 'processing')"
            )


async def generate_student_comment(student: Any, target_id: str) -> str:
    from student.prompt.run_ds_prompt import run_ds_prompt_group_discussion

    # Only this student's already-delivered observations and own chat buffer are supplied.
    observations = [
        {"speaker": item.get("speaker"), "content": item.get("content")}
        for item in student.infos[-6:]
    ]
    own_chat = [str(node.content) for node in (student.scratch.chat_buffer or [])[-6:]]
    context = json.dumps(observations, ensure_ascii=False)
    context += "\nObserver invited a brief side comment to " + target_id
    context += ". Use at most two short sentences. Stay with the current lesson; preserve uncertainty. You may remain silent."
    return await run_ds_prompt_group_discussion(student, context, "\n".join(own_chat), [target_id])


async def run_with_conversations(
    round_action: Awaitable[None],
    process_pending: Callable[[], Awaitable[None]],
) -> None:
    action = asyncio.ensure_future(round_action)
    try:
        while not action.done():
            await process_pending()
            await asyncio.wait({action}, timeout=.1)
        await action
        await process_pending()
    finally:
        # A threaded teacher step cannot be cancelled safely while it may still publish.
        if not action.done():
            await asyncio.gather(action, return_exceptions=True)


async def process_conversation(
    queue: ConversationQueue,
    students: dict[str, Any],
    teacher: Any,
    broadcast_system: Any,
    simulation_time: Any,
    *,
    assistance_allowed: bool,
    generate: Callable[[Any, str], Awaitable[str]] = generate_student_comment,
) -> None:
    request = queue.claim()
    if request is None:
        return
    request_id = request["request_id"]
    source_id, target_id = request["source_id"], request["target_id"]
    if not assistance_allowed or source_id not in students or target_id not in students or source_id == target_id:
        queue.complete(request_id, "rejected", "Peer conversation is not allowed in this phase or for these agents.")
        return

    from util.BroadcastMessage import BroadcastMessage, MessageType

    shared_board = getattr(getattr(broadcast_system.delivery_policy, "phase", None), "architecture", None) == "blackboard"

    def allowed(source: str, target: str) -> bool:
        policy = broadcast_system.delivery_policy
        return policy is None or policy(
            source_id=source, target_id=target, channel="blackboard:write" if shared_board else target,
            message=BroadcastMessage(speaker=source, active_event="group_discussion"),
        )

    if not allowed(source_id, target_id) or not allowed(target_id, source_id):
        queue.complete(request_id, "rejected", "The active architecture does not permit this two-way peer exchange.")
        return

    sent = 0
    try:
        for speaker_id, listener_id in ((source_id, target_id), (target_id, source_id)):
            text = await generate(students[speaker_id], listener_id)
            if not isinstance(text, str):
                raise TypeError("Conversation generator must return text.")
            text = broadcast_system._strip_think_blocks(text).strip()
            if not text or text == '""':
                break
            if not queue.available() or not allowed(speaker_id, listener_id):
                queue.complete(request_id, "rejected", "Live input or communication permission changed before delivery.")
                return
            message = BroadcastMessage(
                current_time=simulation_time, message_type=MessageType.CLASS,
                active_event="group_discussion", speaker=speaker_id, content=text,
                observer_request_id=request_id,
            )
            broadcast_system.publish_sync("blackboard:write" if shared_board else listener_id, message)
            sent += 1
            # Teacher awareness is a separate, policy-checked delivery, never an observer-memory bypass.
            if not shared_board and allowed(speaker_id, str(teacher.name)):
                broadcast_system.publish_sync("teacher", message)
    except Exception as exc:
        queue.complete(request_id, "failed", f"{sent} message(s) delivered before {type(exc).__name__}. Check runner logs; no substitute dialogue was generated.")
        queue.set_ready(False)
        raise
    queue.complete(
        request_id, "completed" if sent == 2 else "declined",
        f"{sent} message(s) delivered. Later lesson decisions may use these observations; no learning gain is assumed.",
    )
