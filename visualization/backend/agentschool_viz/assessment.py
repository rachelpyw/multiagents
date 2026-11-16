from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping

from .schemas import AssessmentPayload, ItemResult


@dataclass(frozen=True)
class AssessmentItem:
    item_id: str
    prompt: str
    answer_key: str
    concept_ids: tuple[str, ...] = ()
    label: str | None = None
    task_type: Literal["classification", "recall", "other"] = "other"
    image_url: str | None = None
    image_alt: str | None = None
    answer_aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class AssessmentBlueprint:
    assessment_id: str
    items: tuple[AssessmentItem, ...]


AnswerProvider = Callable[[str, Mapping[str, Any]], str]


def _normalize_answer(text: str) -> str:
    return " ".join(text.casefold().split())


def run_isolated_assessment(
    *,
    student_id: str,
    checkpoint: str,
    blueprint: AssessmentBlueprint,
    state_snapshot: Mapping[str, Any],
    answer_provider: AnswerProvider,
    test_timing: Literal["unspecified", "pre_lesson", "immediate", "delayed"] = "unspecified",
    retention_delay_seconds: float | None = None,
) -> AssessmentPayload:
    if len({item.item_id for item in blueprint.items}) != len(blueprint.items):
        raise ValueError("assessment blueprint contains duplicate item IDs")
    original = deepcopy(state_snapshot)
    results: list[ItemResult] = []
    for item in blueprint.items:
        result = ItemResult(
            item_id=item.item_id, status="missing", label=item.label, prompt=item.prompt,
            task_type=item.task_type, image_url=item.image_url, image_alt=item.image_alt,
            expected_response=item.answer_key,
        )
        try:
            response = answer_provider(item.prompt, deepcopy(original))
        except Exception as exc:
            results.append(result.model_copy(update={"status": "error", "error": str(exc)}))
            continue
        if response is None or not str(response).strip():
            results.append(result)
            continue
        accepted = {_normalize_answer(answer) for answer in (item.answer_key, *item.answer_aliases)}
        status = "correct" if _normalize_answer(str(response)) in accepted else "wrong"
        results.append(result.model_copy(update={"status": status, "response": str(response)}))

    if state_snapshot != original:
        raise RuntimeError("assessment modified the learning state")
    return score_assessment(
        student_id=student_id,
        checkpoint=checkpoint,
        assessment_id=blueprint.assessment_id,
        expected_count=len(blueprint.items),
        results=results,
        test_timing=test_timing,
        retention_delay_seconds=retention_delay_seconds,
    )


def score_assessment(
    *,
    student_id: str,
    checkpoint: str,
    assessment_id: str,
    expected_count: int,
    results: list[ItemResult],
    test_timing: Literal["unspecified", "pre_lesson", "immediate", "delayed"] = "unspecified",
    retention_delay_seconds: float | None = None,
) -> AssessmentPayload:
    scorable = [result for result in results if result.status in {"correct", "wrong"}]
    correct_count = sum(result.status == "correct" for result in scorable)
    attempted_count = sum(result.status != "missing" for result in results)
    score = correct_count / len(scorable) * 100 if scorable else None
    return AssessmentPayload(
        student_id=student_id,
        assessment_id=assessment_id,
        checkpoint=checkpoint,
        assessment_mode="independent",
        item_results=results,
        correct_count=correct_count,
        scorable_count=len(scorable),
        attempted_count=attempted_count,
        expected_count=expected_count,
        score_percent=score,
        test_timing=test_timing,
        retention_delay_seconds=retention_delay_seconds,
    )
