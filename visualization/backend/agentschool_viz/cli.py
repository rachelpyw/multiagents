from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime
from pathlib import Path

from .adapter import normalize_native_run
from .instrumentation import STUDENT_COLORS
from .schemas import RunManifest, StudentManifest


def load_json(path: Path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def import_run(run_dir: Path, project_root: Path) -> None:
    run_id = run_dir.name
    student_configs = [
        load_json(path) for path in sorted((project_root / "config/student").glob("*.json"))
    ]
    roster = [
        StudentManifest(
            student_id=config["name"],
            display_name=config["name"],
            color=STUDENT_COLORS[index % len(STUDENT_COLORS)],
            initials=config["name"][:2].upper(),
            attributes={
                key: config.get(key)
                for key in (
                    "age",
                    "gender",
                    "grade",
                    "personality",
                    "MBTI",
                    "attention_level",
                    "stress",
                    "cognitive_state",
                    "affective_state",
                    "learning_style",
                    "common_mistakes",
                    "group",
                    "retention",
                )
            },
        )
        for index, config in enumerate(student_configs)
    ]
    teacher = load_json(project_root / "config/teacher.json")
    models = load_json(project_root / "config/model.json")
    schedule = load_json(project_root / "config/schedule.json")
    try:
        upstream_commit = subprocess.check_output(
            ["git", "rev-parse", "upstream/main"], cwd=project_root, text=True
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        upstream_commit = "unknown"
    output = run_dir / "visualization"
    output.mkdir(exist_ok=True)
    manifest = RunManifest(
        run_id=run_id,
        mode="recorded",
        label=f"Recorded AgentSchool run {run_id}",
        created_at=datetime.fromtimestamp(run_dir.stat().st_mtime).isoformat(),
        upstream_commit=upstream_commit,
        roster=roster,
        teacher={"name": teacher.get("name"), "subject": teacher.get("subject")},
        model_identifiers={key: value for key, value in models.items() if key.endswith("_model")},
        run_configuration={"schedule": schedule, "legacy_import": True},
    )
    events = normalize_native_run(run_dir, run_id, {student.student_id for student in roster})
    (output / "manifest.json").write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    with (output / "events.jsonl").open("w", encoding="utf-8") as stream:
        for event in events:
            stream.write(event.model_dump_json() + "\n")
    print(f"Imported {len(events)} interactions into {output}")
    print("Legacy native logs do not contain isolated state snapshots or assessments.")


def main() -> None:
    parser = argparse.ArgumentParser(description="AgentSchool visualization data tools")
    subparsers = parser.add_subparsers(dest="command", required=True)
    importer = subparsers.add_parser("import-run", help="Normalize an existing AgentSchool run")
    importer.add_argument("run_dir", type=Path)
    importer.add_argument("--project-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    if args.command == "import-run":
        import_run(args.run_dir.resolve(), args.project_root.resolve())


if __name__ == "__main__":
    main()
