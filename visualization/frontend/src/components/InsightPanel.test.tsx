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
const nativeEvent = (id: string, student: string, endpoint: string, action: string): NormalizedEvent => ({
  ...event(id, student, {agent_id: student, endpoint, phase: "cognitive", action}),
  source_record_refs: [{path: endpoint === "update_experience"
    ? "runtime/teacher/teacher.py" : `runtime/student/${endpoint}.py`, hook: endpoint}],
});
const props = {
  manifest, states: {}, selectedStudent: "A", mode: "student" as const,
  onMode: vi.fn(), onStudent: vi.fn(), onEvent: vi.fn(), onClose: vi.fn(),
};

afterEach(cleanup);

it("keeps bird previews out of class overview and shows results only after a recorded test", () => {
  const lesson: RunManifest = {...manifest, assessment_definitions: [{
    assessment_id: "birds", item_definitions: [
      {item_id: "duck", label: "Mallard", task_type: "classification", image_url: "/duck.svg"},
      {item_id: "recall", label: "Bill color", task_type: "recall"},
    ],
  }]};
  const events = [
    nativeEvent("0", "A", "plan", "Lesson in progress"),
    event("1", "A", {student_id: "A", assessment_id: "birds", checkpoint: "final", assessment_mode: "independent",
      score_percent: 50, correct_count: 1, scorable_count: 2, expected_count: 2, item_results: [
        {item_id: "duck", status: "correct", response: "Mallard"},
        {item_id: "recall", status: "wrong", response: "Blue"},
      ]}, "assessment"),
  ];
  const onStudent = vi.fn();
  const {rerender} = render(<InsightPanel {...props} manifest={lesson} mode="overview"
    events={events} playhead={0} onStudent={onStudent} />);
  expect(screen.getByText("No test yet")).toBeTruthy();
  expect(screen.queryByRole("heading", {name: "Test results"})).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<InsightPanel {...props} manifest={lesson} mode="overview"
    events={events} playhead={1} onStudent={onStudent} />);
  expect(screen.getByRole("heading", {name: "Test results"})).toBeTruthy();
  expect(screen.getByRole("columnheader", {name: "Birds out of 1"})).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "A"}));
  expect(onStudent).toHaveBeenCalledExactlyOnceWith("A");
});

it("composes character, trail, and endpoint filters without showing future records", () => {
  const events = [
    nativeEvent("0", "A", "perceive", "A perceived the lesson"),
    nativeEvent("1", "B", "plan", "B's private plan"),
    nativeEvent("2", "A", "execute", "Future action"),
  ];
  render(<InsightPanel {...props} events={events} playhead={1} />);
  fireEvent.change(screen.getByLabelText("Trail"), {target: {value: "decisions"}});
  fireEvent.change(screen.getByLabelText("AgentSchool function"), {target: {value: "perceive"}});
  expect(screen.getByText("A perceived the lesson")).toBeTruthy();
  expect(screen.queryByText("B's private plan")).toBeNull();
  expect(screen.queryByText("Future action")).toBeNull();
  expect(screen.queryByRole("option", {name: "execute"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: /A perceived the lesson/}));
  expect((screen.getByLabelText("Trail") as HTMLSelectElement).value).toBe("decisions");
});

it("offers only source-backed native calls, not speech labels, app events, or orchestration hooks", () => {
  const functions = ["perceive", "retrieve", "reflect", "plan", "execute", "update_experience"];
  const events = [
    ...functions.map((name, index) => nativeEvent(String(index), name === "update_experience" ? "Teacher" : "A", name, `${name} completed`)),
    event("6", "A", {active_event: "lecture", content: "Teacher explanation"}, "interaction"),
    event("7", "A", {action: "Unattributed app action"}),
    event("8", "A", {period: "start_class"}, "state_snapshot"),
    {...nativeEvent("9", "Teacher", "class_budget", "Round boundary reached"),
      source_record_refs: [{path: "runtime/teacher/teacher.py", hook: "class_budget"}]},
    event("10", "A", {endpoint: "perceive", phase: "cognitive", action: "Unverified perceive label"}),
  ];
  render(<InsightPanel {...props} mode="overview" events={events} playhead={10} />);
  const options = [...screen.getByLabelText("AgentSchool function").querySelectorAll("option")];
  expect(options.map((option) => option.value)).toEqual(["all", ...functions.sort()]);
  fireEvent.change(screen.getByLabelText("Trail"), {target: {value: "decisions"}});
  expect(screen.getByText("update_experience completed")).toBeTruthy();
  expect(screen.queryByText("Teacher explanation")).toBeNull();
  expect(screen.queryByText("Unattributed app action")).toBeNull();
  expect(screen.queryByText("Round boundary reached")).toBeNull();
  expect(screen.queryByText("Unverified perceive label")).toBeNull();
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
