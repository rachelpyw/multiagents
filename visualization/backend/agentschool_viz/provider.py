from __future__ import annotations

import json
import os
import base64
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

from dotenv import dotenv_values, load_dotenv
from openai import OpenAI, OpenAIError
import resvg_py

from .architecture import ExperimentConfiguration

if TYPE_CHECKING:
    from .mode_runs import Participant

PROJECT_ROOT = Path(__file__).resolve().parents[3]


@lru_cache(maxsize=8)
def image_data_url(url: str) -> str:
    root = PROJECT_ROOT / "visualization/frontend/public/lesson-images"
    path = (PROJECT_ROOT / "visualization/frontend/public" / url.lstrip("/")).resolve()
    if not path.is_relative_to(root.resolve()) or path.suffix != ".svg":
        raise ValueError("Only local lesson illustrations are supported.")
    png = resvg_py.svg_to_bytes(svg_string=path.read_text(), width=384, skip_system_fonts=True)
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def provider_configured() -> bool:
    return bool(os.getenv("SCHOOLAGENT_API_KEY") or dotenv_values(PROJECT_ROOT / ".env").get("SCHOOLAGENT_API_KEY"))


class ClassroomProvider:
    """Bounded model-backed classroom; not the upstream cognitive-module runner."""

    def __init__(self, configuration: ExperimentConfiguration, teacher_id: str):
        load_dotenv(PROJECT_ROOT / ".env")
        self.models = json.loads((PROJECT_ROOT / "config/model.json").read_text())
        self.configuration = configuration
        self.teacher_id = teacher_id
        self.clients = {
            role: OpenAI(api_key=os.environ["SCHOOLAGENT_API_KEY"],
                         base_url=self.models[f"{role}_api_url"], timeout=45, max_retries=0)
            for role in ("teacher", "student")
        }
        self.calls = 0

    def speak(self, person: Participant, instruction: str) -> str:
        if self.calls >= 64:
            raise RuntimeError("The session's 64-request safety limit was reached.")
        self.calls += 1
        role = "teacher" if person.name == self.teacher_id else "student"
        agent = next(agent for agent in self.configuration.agents if agent.agent_id == person.name)
        # No observer transcript, answer key, or other agent's private memory is supplied.
        context = {"received_messages": person.infos[-12:], "your_previous_utterances": person.own[-6:]}
        lesson = self.configuration.lesson_content if "lesson_content" in agent.observable_resources else ""
        content = [{"type": "text", "text": json.dumps(context) + "\nYour next task: " + instruction}]
        if "lesson_content" in agent.observable_resources:
            content.extend({"type": "image_url", "image_url": {"url": image_data_url(url)}}
                           for url in self.configuration.resources if url.startswith("/lesson-images/"))
        response = self.clients[role].chat.completions.create(
            model=self.models[f"{role}_model"], max_tokens=160,
            messages=[
                {"role": "system", "content": f"You are {agent.display_name}, a simulated {role} in a bird-identification classroom. "
                 "Give a short public utterance (at most two sentences), not hidden reasoning. "
                 "Preserve uncertainty. Never claim measured learning gains or unseen observations. "
                 f"Your objective: {agent.objective}. Permitted lesson reference: {lesson}"},
                {"role": "user", "content": content},
            ],
        )
        return response.choices[0].message.content or ""

    def answer(self, prompt: str, state: dict, image_url: str | None) -> str:
        if self.calls >= 64:
            raise RuntimeError("The test request limit was reached.")
        self.calls += 1
        content = [{"type": "text", "text": json.dumps(state) + "\nQuestion: " + prompt}]
        if image_url:
            content.append({"type": "image_url", "image_url": {"url": image_data_url(image_url)}})
        try:
            response = self.clients["student"].chat.completions.create(
                model=self.models["student_model"], max_tokens=60, response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": 'Take an independent test using only your recorded lesson memory and the question. '
                     'No assistance or feedback is available. Return JSON {"answer":"..."}: '
                     'one standard common species name for a bird picture, or one color word for a color question. '
                     'Use "unknown" if unsure. No explanations.'},
                    {"role": "user", "content": content},
                ],
            )
        except OpenAIError as error:
            raise RuntimeError(f"Model request failed: {type(error).__name__} (HTTP {getattr(error, 'status_code', 'unavailable')}).") from None
        try:
            answer = json.loads(response.choices[0].message.content or "")["answer"]
        except (ValueError, KeyError, TypeError):
            raise ValueError("Model returned an invalid answer object.") from None
        if not isinstance(answer, str):
            raise ValueError("Model answer must be text.")
        return answer
