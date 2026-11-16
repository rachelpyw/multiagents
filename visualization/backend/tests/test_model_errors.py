import asyncio
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


def test_provider_failures_raise_instead_of_becoming_agent_dialogue(monkeypatch):
    def fail(**_kwargs):
        raise RuntimeError("provider unavailable")

    async def fail_async(**_kwargs):
        raise RuntimeError("provider unavailable")

    def client(create):
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(
        OpenAI=lambda **_kwargs: client(fail),
        AsyncOpenAI=lambda **_kwargs: client(fail_async),
    ))
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    path = Path(__file__).resolve().parents[3] / "util/model.py"
    spec = importlib.util.spec_from_file_location("model_error_test", path)
    assert spec and spec.loader
    model = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(model)
    with pytest.raises(RuntimeError, match="Native student provider failed: RuntimeError"):
        model.call_LLM_sync("student", [])
    with pytest.raises(RuntimeError, match="Native teacher provider failed: RuntimeError"):
        asyncio.run(model.call_LLM("teacher", []))


def test_english_policy_covers_sync_and_async_calls_without_mutating_native_prompts(monkeypatch):
    captured = []

    def create(**kwargs):
        captured.append(kwargs["messages"])
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="English output"))])

    async def create_async(**kwargs):
        return create(**kwargs)

    def client(function):
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=function)))

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(
        OpenAI=lambda **_: client(create), AsyncOpenAI=lambda **_: client(create_async)))
    monkeypatch.setenv("SCHOOLAGENT_API_KEY", "unit-test-placeholder")
    monkeypatch.setenv("AGENTSCHOOL_OUTPUT_LANGUAGE", "en")
    path = Path(__file__).resolve().parents[3] / "util/model.py"
    spec = importlib.util.spec_from_file_location("model_language_test", path)
    assert spec and spec.loader
    model = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(model)
    messages = [{"role": "user", "content": "Native prompt with required machine labels"}]
    model.call_LLM_sync("teacher", messages)
    asyncio.run(model.call_LLM("student", messages))
    assert len(messages) == 1
    assert len(captured) == 2
    assert all(batch[-1]["role"] == "system" and "English only" in batch[-1]["content"] for batch in captured)
    plan = model.language_messages([{"role": "user", "content": 'Return a plan with "method" and "content".'}])
    assert "陈述知识点" in plan[-1]["content"]
    assert "陈述知识点" not in captured[0][-1]["content"]
