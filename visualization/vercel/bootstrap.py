"""Idempotent startup inside the persistent Vercel classroom sandbox."""

import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

HOME = Path("/vercel/sandbox")
CODE = HOME / "agentschool"
RUNS = HOME / "classroom-runs"
STATE = HOME / "classroom-server.json"
LOG = HOME / "classroom-startup.log"
FAILURE = HOME / "classroom-startup-error.json"


def ready(revision: str, session: str) -> bool:
    if not STATE.exists():
        return False
    state = json.loads(STATE.read_text())
    if state["revision"] != revision or state["session"] != session:
        return False
    request = urllib.request.Request("http://127.0.0.1:8000/api/classroom",
                                    headers={"X-Classroom-Token": os.environ["AGENTSCHOOL_BACKEND_TOKEN"]})
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def start(revision: str, session: str) -> None:
    with (HOME / "classroom-startup.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if ready(revision, session):
            return
        previous = json.loads(STATE.read_text()) if STATE.exists() else None
        if previous and previous["session"] == session:
            try:
                os.kill(previous["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif previous:
            for path in RUNS.glob("*/visualization/manifest.json"):
                manifest = json.loads(path.read_text())
                configuration = manifest.get("run_configuration", {})
                if manifest["mode"] == "live":
                    manifest["mode"] = "recorded"
                    configuration.update(status="failed", error="The Vercel runtime session ended before this run completed. Start a new class.")
                    path.write_text(json.dumps(manifest))
        CODE.mkdir(exist_ok=True)
        with tarfile.open(HOME / f"classroom-source-{revision}.tar.gz", "r:gz") as archive:
            archive.extractall(CODE, filter="data")
        python = CODE / ".venv/bin/python"
        if not python.exists():
            subprocess.run(["uv", "venv", "--python", "3.12", str(CODE / ".venv")], check=True)
        dependency_revision = HOME / "classroom-dependencies.txt"
        manifest_bytes = (CODE / "visualization/backend/pyproject.toml").read_bytes()
        if not dependency_revision.exists() or dependency_revision.read_bytes() != manifest_bytes:
            if shutil.which("g++") is None:
                subprocess.run(["sudo", "-n", "apt-get", "update"], check=True)
                subprocess.run(["sudo", "-n", "apt-get", "install", "-y", "--no-install-recommends", "g++"], check=True)
            subprocess.run(["uv", "pip", "install", "--python", str(python), "torch",
                            "--index-url", "https://download.pytorch.org/whl/cpu"], check=True)
            subprocess.run(["uv", "pip", "install", "--python", str(python),
                            "-e", str(CODE / "visualization/backend") + "[native]"], check=True)
            dependency_revision.write_bytes(manifest_bytes)
        environment = os.environ.copy()
        environment.update(PYTHONPATH=str(CODE) + ":" + str(CODE / "visualization/backend"),
                           AGENTSCHOOL_RUNS_DIR=str(RUNS), PYTHONUNBUFFERED="1",
                           BGE_MODEL="BAAI/bge-small-zh-v1.5", BGE_MODEL_L="BAAI/bge-small-zh-v1.5")
        RUNS.mkdir(exist_ok=True)
        # Acquire weights before exposing live availability, rather than during the first lesson.
        subprocess.run([str(python), "-c",
                        "from sentence_transformers import SentenceTransformer; "
                        "SentenceTransformer('BAAI/bge-small-zh-v1.5').encode(['Classroom readiness'])"],
                       env=environment, cwd=CODE, check=True)
        with (HOME / "classroom-api.log").open("a") as log:
            process = subprocess.Popen([str(python), "-m", "uvicorn", "agentschool_viz.app:app",
                                        "--host", "0.0.0.0", "--port", "8000"],
                                       cwd=CODE, env=environment, stdout=log, stderr=log)
        STATE.write_text(json.dumps({"revision": revision, "session": session, "pid": process.pid}))
        for _ in range(60):
            if ready(revision, session):
                return
            if process.poll() is not None:
                raise RuntimeError("The native classroom API exited during startup.")
            time.sleep(1)
        raise TimeoutError("The native classroom API did not become ready.")


if __name__ == "__main__":
    revision, session = sys.argv[2:4]
    if sys.argv[1] == "start":
        try:
            start(revision, session)
        except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
            FAILURE.write_text(json.dumps({"revision": revision, "session": session, "error": type(error).__name__}))
            raise
    elif ready(revision, session):
        print("ready")
    elif FAILURE.exists() and json.loads(FAILURE.read_text())["revision"] == revision:
        print("failed")
    elif not (HOME / f"classroom-source-{revision}.tar.gz").exists():
        print("needs-source")
    else:
        with LOG.open("a") as log:
            subprocess.Popen([sys.executable, __file__, "start", revision, session],
                             stdout=log, stderr=log)
        print("starting")
