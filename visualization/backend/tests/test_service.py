from pathlib import Path

from agentschool_viz.service import RunService


FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def test_synthetic_fixture_validates_and_preserves_zero():
    service = RunService(Path("/does/not/exist"))
    service.fixture_root = FIXTURES
    manifest = service.manifest("synthetic-tutorial")
    events = service.events("synthetic-tutorial")
    first = events[0]
    assert first.payload["concepts"][0]["normalized_mastery"] == 0
    assert len({event.event_id for event in events}) == len(events)
    assert manifest.roster[0].attributes["attention_level"] == 0.34
    assert manifest.roster[0].attributes["common_mistakes"]
    lesson = next(event for event in events if event.payload.get("lesson_image_url"))
    assert lesson.payload["lesson_image_alt"].startswith("Pixel illustration")


def test_newest_run_selection_compares_instants_across_timezone_offsets(tmp_path):
    service = RunService(tmp_path)
    original = service.manifest("synthetic-tutorial")
    for run_id, created in (("next-class", "2026-11-15T23:58:00-08:00"),
                            ("previous-test", "2026-11-16T07:57:00+00:00")):
        folder = tmp_path / run_id / "visualization"
        folder.mkdir(parents=True)
        manifest = original.model_copy(update={"run_id": run_id, "created_at": created})
        (folder / "manifest.json").write_text(manifest.model_dump_json())
    assert [manifest.run_id for manifest in service.list_runs()][:2] == ["next-class", "previous-test"]
