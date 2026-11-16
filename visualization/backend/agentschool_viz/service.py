from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

from .adapter import read_jsonl
from .schemas import NormalizedEvent, RunManifest


class RunNotFoundError(FileNotFoundError):
    pass


class RunService:
    def __init__(self, runs_root: Path | None = None):
        default = Path(__file__).resolve().parents[2] / "fixtures"
        self.runs_root = runs_root or Path(os.getenv("AGENTSCHOOL_RUNS_DIR", "logs"))
        self.fixture_root = default

    def _run_dir(self, run_id: str) -> Path:
        if Path(run_id).name != run_id:
            raise RunNotFoundError(run_id)
        candidates = [
            self.runs_root / run_id / "visualization",
            self.fixture_root / run_id,
        ]
        for candidate in candidates:
            if candidate.joinpath("manifest.json").exists():
                return candidate
        raise RunNotFoundError(run_id)

    def list_runs(self) -> list[RunManifest]:
        manifests: list[RunManifest] = []
        roots = [self.runs_root, self.fixture_root]
        for root in roots:
            if not root.exists():
                continue
            for path in root.glob("*/manifest.json"):
                manifests.append(RunManifest.model_validate_json(path.read_text(encoding="utf-8")))
            for path in root.glob("*/visualization/manifest.json"):
                manifests.append(RunManifest.model_validate_json(path.read_text(encoding="utf-8")))
        unique = {manifest.run_id: manifest for manifest in manifests}
        def creation_time(item: RunManifest) -> datetime:
            value = datetime.fromisoformat(item.created_at.replace("Z", "+00:00"))
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

        return sorted(unique.values(), key=creation_time, reverse=True)

    def manifest(self, run_id: str) -> RunManifest:
        path = self._run_dir(run_id) / "manifest.json"
        return RunManifest.model_validate_json(path.read_text(encoding="utf-8"))

    def events(self, run_id: str) -> list[NormalizedEvent]:
        path = self._run_dir(run_id) / "events.jsonl"
        events: list[NormalizedEvent] = []
        seen: set[str] = set()
        for parsed in read_jsonl(path):
            try:
                event = NormalizedEvent.model_validate(parsed.value)
            except ValueError:
                continue
            if event.event_id not in seen:
                seen.add(event.event_id)
                events.append(event)
        return sorted(events, key=lambda event: (event.simulation_time, event.sequence))

    async def stream(self, run_id: str) -> AsyncIterator[str]:
        emitted: set[str] = set()
        while True:
            for event in self.events(run_id):
                if event.event_id in emitted:
                    continue
                emitted.add(event.event_id)
                yield f"id: {event.event_id}\ndata: {event.model_dump_json()}\n\n"
            await asyncio.sleep(0.75)
