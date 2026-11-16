from agentschool_viz.assessment import (
    AssessmentBlueprint,
    AssessmentItem,
    run_isolated_assessment,
)


def test_assessment_preserves_state_and_missingness():
    state = {"mastery": {"integers": 0}}
    blueprint = AssessmentBlueprint(
        "fixed-v1",
        (
            AssessmentItem("one", "1 + 1", "2"),
            AssessmentItem("two", "unanswered", "x"),
            AssessmentItem("three", "error", "x"),
        ),
    )

    def answer(prompt, isolated):
        assert isolated["mastery"]["integers"] == 0
        isolated["mastery"]["integers"] = 99
        if prompt == "unanswered":
            return ""
        if prompt == "error":
            raise RuntimeError("tool failed")
        return "2"

    payload = run_isolated_assessment(
        student_id="StudentA",
        checkpoint="baseline",
        blueprint=blueprint,
        state_snapshot=state,
        answer_provider=answer,
    )
    assert state == {"mastery": {"integers": 0}}
    assert payload.correct_count == 1
    assert payload.scorable_count == 1
    assert payload.score_percent == 100
    assert [item.status for item in payload.item_results] == ["correct", "missing", "error"]


def test_classification_records_picture_and_answer_without_leaking_keys_to_provider():
    blueprint = AssessmentBlueprint("birds-v1", (
        AssessmentItem("bird", "Identify the bird", "Mallard", label="Duck",
                       task_type="classification", image_url="/mallard.svg", image_alt="Bird",
                       answer_aliases=("Anas platyrhynchos",)),
        AssessmentItem("recall", "Recall its bill color", "Yellow", task_type="recall"),
    ))
    state = {"own_memory": ["The bill was yellow."]}

    def answer(prompt, isolated):
        assert isolated == state
        assert set(isolated) == {"own_memory"}
        return "  ANAS   PLATYRHYNCHOS " if prompt == "Identify the bird" else "yellow"

    result = run_isolated_assessment(
        student_id="A", checkpoint="final", blueprint=blueprint, state_snapshot=state,
        answer_provider=answer, test_timing="immediate",
    )
    assert result.correct_count == 2
    assert result.item_results[0].image_url == "/mallard.svg"
    assert result.item_results[0].response == "  ANAS   PLATYRHYNCHOS "
    assert result.item_results[0].expected_response == "Mallard"
    assert result.item_results[1].task_type == "recall"
    assert result.test_timing == "immediate"
    assert result.retention_delay_seconds is None


def test_duplicate_questions_cannot_inflate_assessment():
    blueprint = AssessmentBlueprint("duplicate", (AssessmentItem("a", "One", "1"), AssessmentItem("a", "Two", "2")))
    with pytest.raises(ValueError, match="duplicate item IDs"):
        run_isolated_assessment(
            student_id="A", checkpoint="final", blueprint=blueprint, state_snapshot={},
            answer_provider=lambda *_: pytest.fail("Invalid tests must fail before model invocation"),
        )

import pytest
