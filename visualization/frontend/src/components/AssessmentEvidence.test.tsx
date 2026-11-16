import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {AssessmentEvidence} from "./AssessmentEvidence";
import {AssessmentItemDefinition, NormalizedEvent, RunManifest} from "../types";

afterEach(cleanup);

it("pictures the misclassified animal without calling an image failure a wrong answer or inventing responses", () => {
  const manifest: RunManifest = {
    schema_version: "1.0", run_id: "test", mode: "synthetic", label: "Test", upstream_commit: "test",
    created_at: "2025-09-01T08:00:00", teacher: {}, concept_mapping: {},
    roster: [{student_id: "A", display_name: "Avery", initials: "A", color: "#456", attributes: {}}],
    assessment_definitions: [{assessment_id: "birds", item_definitions: [
      {item_id: "duck", label: "Mallard", task_type: "classification", image_url: "/duck.svg", image_alt: "Mallard picture"},
      {item_id: "pigeon", label: "Rock pigeon", task_type: "classification", image_url: "/pigeon.svg"},
    ]}],
  };
  const event: NormalizedEvent = {
    schema_version: "1.0", run_id: "test", event_id: "score", sequence: 0,
    event_kind: "assessment", simulation_time: "2025-09-01T08:10:00", student_ids: ["A"], source_record_refs: [],
    payload: {student_id: "A", assessment_id: "birds", checkpoint: "final", assessment_mode: "independent",
      expected_count: 2, item_results: [{item_id: "duck", status: "wrong"}, {item_id: "pigeon", status: "error"}]},
  };
  render(<AssessmentEvidence manifest={manifest} events={[event]} playhead={0} studentId="A" onStudent={vi.fn()} />);
  expect(screen.getByRole("article", {name: "Mallard: Incorrect"}).querySelector("img")?.getAttribute("src")).toBe("/duck.svg");
  expect(screen.getByRole("article", {name: "Rock pigeon: Tool / model error"}).textContent).not.toContain("Incorrect");
  expect(screen.getAllByText(/Answer text not recorded/)).toHaveLength(2);
  expect(screen.getByText(/No delayed recall test/)).toBeTruthy();
  expect(screen.getByText("Test results")).toBeTruthy();
  expect(screen.queryByText("Animal learning check")).toBeNull();
});

it("separates six bird identifications from recall in a readable student summary", () => {
  const items: AssessmentItemDefinition[] = ["Mallard", "Green-winged teal", "Rock pigeon", "Canada goose", "Mute swan", "Northern cardinal"]
    .map((label, index) => ({item_id: `bird-${index}`, label, task_type: "classification", image_url: `/bird-${index}.svg`}));
  items.push({item_id: "recall", label: "Bill color", task_type: "recall"});
  const manifest: RunManifest = {
    schema_version: "1.0", run_id: "test", mode: "recorded", label: "Test", upstream_commit: "test",
    created_at: "2025-09-01T08:00:00", teacher: {}, concept_mapping: {},
    roster: [{student_id: "A", display_name: "Avery", initials: "A", color: "#456", attributes: {}}],
    assessment_definitions: [{assessment_id: "birds", item_definitions: items}],
  };
  const event: NormalizedEvent = {
    schema_version: "1.0", run_id: "test", event_id: "result", sequence: 0, event_kind: "assessment",
    simulation_time: "2025-09-01T08:10:00", student_ids: ["A"], source_record_refs: [],
    payload: {student_id: "A", assessment_id: "birds", checkpoint: "final", assessment_mode: "independent", expected_count: 7,
      item_results: items.map((item, index) => ({item_id: item.item_id, status: index === 5 ? "error" : "correct"}))},
  };
  const onStudent = vi.fn();
  render(<AssessmentEvidence manifest={manifest} events={[event]} playhead={0} onStudent={onStudent} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("columnheader", {name: "Birds out of 6"})).toBeTruthy();
  expect(screen.getByRole("columnheader", {name: "Recall out of 1"})).toBeTruthy();
  expect(screen.getByText("5/6")).toBeTruthy();
  expect(screen.getByText("1/1")).toBeTruthy();
  expect(screen.getByText("Model error")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Avery"}));
  expect(onStudent).toHaveBeenCalledWith("A");
});
