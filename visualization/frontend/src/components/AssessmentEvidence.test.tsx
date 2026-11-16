import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {AssessmentEvidence} from "./AssessmentEvidence";
import {NormalizedEvent, RunManifest} from "../types";

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
