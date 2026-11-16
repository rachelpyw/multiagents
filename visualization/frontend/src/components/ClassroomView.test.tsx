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
  conversationReady: true, conversationPending: false,
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
    fireEvent.click(document.querySelector('[data-floor-x="428"][data-floor-y="556"]')!);
    act(() => vi.advanceTimersByTime(6000));
    expect((screen.getByRole("button", {name: "Space · Talk to Student A"}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document.body, {code: "Space"});
    expect(props.onTalk).toHaveBeenCalledExactlyOnceWith("A");
    fireEvent.keyDown(document.body, {code: "Space", repeat: true});
    fireEvent.keyDown(screen.getByRole("button", {name: "Unrelated control"}), {code: "Space"});
    expect(props.onTalk).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent)
      .toContain("The bill is yellow.");
    expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent)
      .toContain("Side conversation");
  });

  it("can steer a speaking student directly without moving onto occupied tiles or leaving history", () => {
    const roster = [...manifest.roster, {...manifest.roster[0], student_id: "C", display_name: "Student C"}];
    const live = {...manifest, roster};
    render(<ClassroomView {...props} manifest={live} selectedStudent="A" followingLive={false}
      activePhase={createPreset(live, "blackboard").phases[0]} />);
    fireEvent.change(screen.getByRole("combobox", {name: "Conversation partner"}), {target: {value: "C"}});
    fireEvent.click(screen.getByRole("button", {name: "Space · Talk to Student C"}));
    expect(props.onTalk).toHaveBeenCalledExactlyOnceWith("C");
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

  it("distinguishes blocked steering from a response that received the side conversation", () => {
    const response = {...line, payload: {...line.payload, observer_request_id: undefined, steering_context_ids: ["request-1"]}};
    render(<ClassroomView {...props} interactions={[response]}
      activePhase={createPreset(manifest, "supervisor").phases[0]} />);
    expect((screen.getByRole("button", {name: "Peer steering blocked"}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Using side conversation")).toBeTruthy();
    expect(screen.queryByText("Side conversation", {exact: true})).toBeNull();
    expect(document.querySelector(".room-legend")).toBeNull();
  });
});
