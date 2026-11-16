"""Bundle only committed native source, never local credentials or run data."""

from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
output = Path(__file__).with_name("classroom-source.tar.gz")
with output.open("wb") as stream:
    subprocess.run([
        "git", "archive", "--format=tar.gz", "HEAD", "config", "student", "teacher", "util",
        "visualization/backend", "visualization/fixtures", "visualization/frontend/public/lesson-images",
    ], cwd=root, stdout=stream, check=True)
