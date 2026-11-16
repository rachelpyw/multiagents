import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createPreset} from "../experiment";
import {classroomActivity} from "../replay";
import {NormalizedEvent, RunManifest} from "../types";
import {ClassroomView} from "./ClassroomView";

const manifest: RunManifest = {
  schema_version: "1.0", run_id: "live", mode: "live", label: "Live",
  created_at: "2025-09-01T08:00:00", upstream_commit: "test", concept_mapping: {},
  teacher: {name: "Teacher"},
  roster: ["A", "B"].map((id) => ({
    student_id: id, display_name: `Student ${id}`, color: "#56789a", initials: id, attributes: {},
  })),
};
const line: NormalizedEvent = {
  schema_version: "1.0", run_id: "live", event_id: "line", sequence: 0,
  simulation_time: "2025-09-01T08:02:00", event_kind: "interaction", student_ids: ["A"],
  source_record_refs: [{path: "test"}],
  payload: {speaker_id: "A", content: "The bill is yellow.", observer_request_id: "request-1"},
};
const props = {
  manifest, interactions: [line], activity: classroomActivity([line], 0, "Teacher"),
  activePhase: createPreset(manifest, "decentralized").phases[0],
  selectedStudent: "B", conversationNotice: "", followingLive: true,
  conversationReady: true,
  onStartTest: vi.fn(), canStartTest: true, testStarting: false, testCompleted: 0,
  onNextClass: vi.fn(), canNextClass: false, classStarting: false,
  onTalk: vi.fn(), onFollowLive: vi.fn(), onStudent: vi.fn(), onEvent: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("classroom live dialogue", () => {
  it("shows a larger bubble only on the current speaker, including the teacher", () => {
    const {rerender} = render(<ClassroomView {...props} />);
    expect(document.querySelectorAll(".talking-bubble")).toHaveLength(1);
    expect(document.querySelector(".student-sprite-button.speaking .talking-bubble")).toBeTruthy();
    const teacher = {...line, event_id: "teacher", student_ids: [],
      payload: {speaker_id: "Teacher", content: "Compare the birds.", interaction_type: "question"}};
    rerender(<ClassroomView {...props} interactions={[line, teacher]} />);
    expect(document.querySelectorAll(".talking-bubble")).toHaveLength(1);
    expect(document.querySelector(".teacher-sprite.speaking .talking-bubble")).toBeTruthy();
    expect(screen.getByRole("img", {name: "Asking a question"})).toBeTruthy();
  });

  it("shows named birds on the board, retains context for student attributes, and hides pictures during tests", () => {
    const lesson: RunManifest = {...manifest, assessment_definitions: [{
      assessment_id: "birds", item_definitions: [
        {item_id: "mallard", label: "Mallard", task_type: "classification", image_url: "/mallard.svg"},
        {item_id: "teal", label: "Green-winged teal", task_type: "classification", image_url: "/teal.svg"},
      ],
    }]};
    const teacher = {...line, event_id: "teacher",
      payload: {speaker_id: "Teacher", content: "Look at the mallards' bills."}};
    const attribute = {...line, event_id: "attribute", payload: {...line.payload, content: "Its bill is yellow."}};
    const comparison = {...line, event_id: "compare", payload: {...line.payload, content: "The teal has a different head than the mallard."}};
    const {rerender} = render(<ClassroomView {...props} manifest={lesson} interactions={[teacher, attribute, comparison]} selectedEvent="teacher" />);
    expect(document.querySelector(".lesson-board image")?.getAttribute("href")).toBe("/mallard.svg");
    rerender(<ClassroomView {...props} manifest={lesson} interactions={[teacher, attribute, comparison]} selectedEvent="attribute" />);
    expect(document.querySelectorAll(".lesson-board image")).toHaveLength(1);
    expect(document.querySelector(".lesson-board image")?.getAttribute("href")).toBe("/mallard.svg");
    rerender(<ClassroomView {...props} manifest={lesson} interactions={[teacher, attribute, comparison]} />);
    expect(document.querySelectorAll(".lesson-board image")).toHaveLength(2);
    rerender(<ClassroomView {...props} manifest={lesson} interactions={[teacher, attribute, comparison]} activity={{...props.activity, isTest: true}} />);
    expect(document.querySelector(".lesson-board")).toBeNull();
    expect(document.querySelector(".talking-bubble")).toBeNull();
    const recorded = {...teacher, payload: {...teacher.payload,
      lesson_image_url: "/recorded.svg", lesson_image_alt: "Recorded lesson picture"}};
    rerender(<ClassroomView {...props} manifest={lesson} interactions={[recorded, comparison]} selectedEvent="teacher" />);
    expect(document.querySelector(".lesson-board image")?.getAttribute("href")).toBe("/recorded.svg");
    rerender(<ClassroomView {...props} manifest={lesson} interactions={[]} />);
    expect(document.querySelector(".lesson-board")).toBeNull();
  });

  it("lights only the displayed speaker and returns to class after testing", () => {
    const {rerender} = render(<ClassroomView {...props} />);
    expect(document.querySelectorAll(".speaking .sprite-nameplate")).toHaveLength(1);
    expect(document.querySelector(".speaking .sprite-nameplate")?.textContent).toBe("Student A");
    const completed = {...line, event_kind: "agent_action" as const,
      payload: {agent_id: "Teacher", role: "teacher", action: "Test complete", phase: "test_complete"}};
    rerender(<ClassroomView {...props} activity={classroomActivity([completed], 0, "Teacher")} canNextClass />);
    expect(document.querySelector(".speaking")).toBeNull();
    expect(document.querySelector(".action-test")).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "Next class"}));
    expect(props.onNextClass).toHaveBeenCalledOnce();
  });
  it("uses nearby preview geometry for Space, ignoring repeat and focused controls", () => {
    vi.useFakeTimers();
    render(<><ClassroomView {...props} /><button>Unrelated control</button></>);
    expect(screen.queryByRole("button", {name: "Talk to Student A"})).toBeNull();
    expect(screen.queryByRole("combobox", {name: "Conversation partner"})).toBeNull();
    fireEvent.keyDown(document.body, {code: "Space"});
    expect(props.onTalk).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-floor-x="428"][data-floor-y="556"]')!);
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByText("[space] to talk").closest("svg")).toBeTruthy();
    fireEvent.keyDown(document.body, {code: "Space"});
    expect(props.onTalk).toHaveBeenCalledExactlyOnceWith("A");
    fireEvent.keyDown(document.body, {code: "Space", repeat: true});
    fireEvent.keyDown(screen.getByRole("button", {name: "Unrelated control"}), {code: "Space"});
    expect(props.onTalk).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent)
      .toContain("The bill is yellow.");
    fireEvent.click(document.querySelector('[data-floor-x="680"][data-floor-y="610"]')!);
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText("[space] to talk")).toBeNull();
  });

  it("can steer a speaking student from history once nearby, without submitting twice", () => {
    vi.useFakeTimers();
    render(<ClassroomView {...props} selectedStudent="A" followingLive={false}
      activePhase={createPreset(manifest, "blackboard").phases[0]} />);
    fireEvent.click(document.querySelector('[data-floor-x="608"][data-floor-y="466"]')!);
    act(() => vi.advanceTimersByTime(6000));
    fireEvent.keyDown(screen.getByRole("button", {name: "Talk to Student B"}), {code: "Space"});
    expect(props.onTalk).toHaveBeenCalledExactlyOnceWith("B");
    expect(document.querySelector(".speaking .sprite-nameplate")?.textContent).toBe("Student A");
    expect(screen.getByText("The bill is yellow.")).toBeTruthy();
  });

  it("does not trigger live requests in replay or reveal an invisible selected message", () => {
    const {rerender} = render(<ClassroomView {...props} />);
    rerender(<ClassroomView {...props} manifest={{...manifest, mode: "recorded", roster: manifest.roster.slice(0, 1)}}
      interactions={[]} selectedEvent="line" />);
    fireEvent.keyDown(document.body, {code: "Space"});
    expect(props.onTalk).not.toHaveBeenCalled();
    expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent)
      .not.toContain("The bill is yellow.");
  });

  it("shows one steering status and a check only on completion", () => {
    vi.useFakeTimers();
    const {rerender} = render(<ClassroomView {...props} />);
    fireEvent.click(document.querySelector('[data-floor-x="428"][data-floor-y="556"]')!);
    act(() => vi.advanceTimersByTime(6000));
    fireEvent.click(screen.getByRole("button", {name: "Talk to Student A"}));
    expect(props.onTalk).toHaveBeenCalledExactlyOnceWith("A");
    rerender(<ClassroomView {...props} steeringState="pending" />);
    expect(screen.getByText("Steering…")).toBeTruthy();
    expect(screen.queryByRole("img", {name: "Complete"})).toBeNull();
    expect(screen.queryByText("[space] to talk")).toBeNull();
    fireEvent.keyDown(document.body, {code: "Space"});
    expect(props.onTalk).toHaveBeenCalledTimes(1);
    rerender(<ClassroomView {...props} steeringState="complete" />);
    expect(screen.getByRole("img", {name: "Complete"})).toBeTruthy();
    expect(screen.getByText("Steering…")).toBeTruthy();
    expect(screen.queryByText(/Steering delivered|Dialogue keeps going/)).toBeNull();
    rerender(<ClassroomView {...props} conversationNotice="Request declined: no student chose to speak." />);
    expect(screen.getByText("Request declined: no student chose to speak.")).toBeTruthy();
    expect(screen.queryByRole("img", {name: "Complete"})).toBeNull();
  });

  it("does not offer an overlapping peer exchange when policy, availability, replay, or testing forbids it", () => {
    vi.useFakeTimers();
    const {rerender} = render(<ClassroomView {...props} />);
    fireEvent.click(document.querySelector('[data-floor-x="428"][data-floor-y="556"]')!);
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByText("[space] to talk")).toBeTruthy();
    for (const blocked of [
      {activePhase: createPreset(manifest, "supervisor").phases[0]},
      {conversationReady: false},
      {manifest: {...manifest, mode: "recorded" as const}},
      {activity: {...props.activity, isTest: true}},
    ]) {
      rerender(<ClassroomView {...props} {...blocked} />);
      expect(screen.queryByText("[space] to talk")).toBeNull();
      fireEvent.keyDown(document.body, {code: "Space"});
    }
    expect(props.onTalk).not.toHaveBeenCalled();
    expect(document.querySelector(".room-legend")).toBeNull();
  });
});
