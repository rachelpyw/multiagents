import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {NormalizedEvent, RunManifest} from "../types";
import {InsightPanel} from "./InsightPanel";

const manifest: RunManifest = {
  schema_version: "1.0", run_id: "native", mode: "recorded", label: "Native",
  created_at: "2025-09-01T08:00:00", upstream_commit: "test", teacher: {name: "Teacher"}, concept_mapping: {},
  roster: ["A", "B"].map((id) => ({student_id: id, display_name: id, color: "#56789a", initials: id, attributes: {}})),
};
const event = (id: string, student: string, payload: NormalizedEvent["payload"], kind: NormalizedEvent["event_kind"] = "agent_action"): NormalizedEvent => ({
  schema_version: "1.0", run_id: "native", event_id: id, sequence: Number(id),
  simulation_time: "2025-09-01T08:00:00", event_kind: kind, student_ids: [student], source_record_refs: [],
  payload,
});
const props = {
  manifest, states: {}, selectedStudent: "A", mode: "student" as const,
  onMode: vi.fn(), onStudent: vi.fn(), onEvent: vi.fn(), onClose: vi.fn(),
};

afterEach(cleanup);

it("composes character, trail, and endpoint filters without showing future records", () => {
  const events = [
    event("0", "A", {agent_id: "A", endpoint: "perceive", action: "A perceived the lesson"}),
    event("1", "B", {agent_id: "B", endpoint: "plan", action: "B's private plan"}),
    event("2", "A", {agent_id: "A", endpoint: "execute", action: "Future action"}),
  ];
  render(<InsightPanel {...props} events={events} playhead={1} />);
  fireEvent.change(screen.getByLabelText("Trail"), {target: {value: "decisions"}});
  fireEvent.change(screen.getByLabelText("Decision endpoint"), {target: {value: "perceive"}});
  expect(screen.getByText("A perceived the lesson")).toBeTruthy();
  expect(screen.queryByText("B's private plan")).toBeNull();
  expect(screen.queryByText("Future action")).toBeNull();
  expect(screen.queryByRole("option", {name: "execute"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: /A perceived the lesson/}));
  expect((screen.getByLabelText("Trail") as HTMLSelectElement).value).toBe("decisions");
});

it("shows only incorrectly classified pictures when outcome and test filters are combined", () => {
  const result = event("0", "A", {student_id: "A", assessment_id: "birds", checkpoint: "final",
    score_percent: 50, correct_count: 1, expected_count: 2, item_results: [
      {item_id: "wrong", label: "Teal", image_url: "/teal.png", status: "wrong", response: "Mallard", expected_response: "Teal"},
      {item_id: "right", label: "Mallard", image_url: "/mallard.png", status: "correct", response: "Mallard", expected_response: "Mallard"},
    ]}, "assessment");
  render(<InsightPanel {...props} events={[result]} playhead={0} />);
  fireEvent.change(screen.getByLabelText("Trail"), {target: {value: "tests"}});
  fireEvent.change(screen.getByLabelText("Outcome"), {target: {value: "wrong"}});
  expect(screen.getByRole("img", {name: "Teal"})).toBeTruthy();
  expect(screen.queryByRole("img", {name: "Mallard"})).toBeNull();
  expect(screen.getByText("Answer: Mallard · Expected: Teal")).toBeTruthy();
});
