import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import App from "./App";
import {NormalizedEvent, RunManifest} from "./types";
import {createPreset} from "./experiment";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([true, false])("opens an English recording or demo rather than older non-English native data (%s)", async (hasEnglishRun) => {
  const base: RunManifest = {
    schema_version: "1.0", run_id: "demo", mode: "synthetic", label: "Demo",
    created_at: "2025-09-01T08:00:00", upstream_commit: "test", teacher: {name: "Teacher"}, concept_mapping: {},
    roster: [{student_id: "A", display_name: "Avery", initials: "A", color: "#456", attributes: {}}],
  };
  const old = {...base, run_id: "older-language", mode: "recorded" as const, run_configuration: {runner: "native"}};
  const english = {...base, run_id: "english", run_configuration: {runner: "native", language: "en"}};
  const runs = hasEnglishRun ? [old, english, base] : [old, base];
  const expected = hasEnglishRun ? english : base;
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
    url === "/api/runs" ? runs : url.endsWith("/events") ? [] : expected)));
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/runs/${expected.run_id}/manifest`));
  expect(fetchMock).not.toHaveBeenCalledWith("/api/runs/older-language/manifest");
});

it("queues live steering during dialogue and while viewing earlier messages", async () => {
  const manifest: RunManifest = {
    schema_version: "1.0", run_id: "live", mode: "live", label: "Live test",
    created_at: "2025-09-01T08:00:00", upstream_commit: "test", concept_mapping: {},
    teacher: {name: "Teacher"},
    roster: ["A", "B"].map((id) => ({
      student_id: id, display_name: id, color: "#56789a", initials: id, attributes: {},
    })),
  };
  const question: NormalizedEvent = {
    schema_version: "1.0", run_id: "live", event_id: "question", sequence: 0,
    simulation_time: "2025-09-01T08:02:00", event_kind: "interaction", student_ids: [],
    source_record_refs: [{path: "test"}],
    payload: {speaker_id: "Teacher", content: "What bird is this?", interaction_type: "question"},
  };
  manifest.run_configuration = {experiment: createPreset(manifest, "decentralized")};
  const request = vi.fn(async (_url: string, _options: RequestInit) =>
    new Response(JSON.stringify({request_id: "request-1"}), {status: 202}));
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") return request(url, options);
    const body = url === "/api/runs" ? [manifest]
      : url.endsWith("/manifest") ? manifest
      : url.endsWith("/events") ? [question]
      : url.endsWith("/conversations") ? {available: true, mode: "live"}
      : {status: "completed", detail: "2 messages delivered."};
    return new Response(JSON.stringify(body));
  });
  let stream: {
    onmessage: ((event: {data: string}) => void) | null;
    onopen: (() => void) | null;
    onerror: (() => void) | null;
  } | undefined;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class {
    onopen = null;
    onerror = null;
    onmessage = null;
    constructor() { stream = this; }
    close() {}
  });
  render(<App />);
  await screen.findByRole("region", {name: "Classroom dialogue"});
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/live/conversations"));
  act(() => stream?.onerror?.());
  expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent).toContain("Connection lost; reconnecting");
  act(() => stream?.onopen?.());
  expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent).not.toContain("Connection lost; reconnecting");
  fireEvent.click(screen.getByRole("button", {name: "Select B"}));
  fireEvent.click(document.querySelector('[data-floor-x="428"][data-floor-y="556"]')!);
  await waitFor(() => expect(screen.getByRole("button", {name: "Select B"}).classList.contains("walking"))
    .toBe(false), {timeout: 6000});
  fireEvent.keyDown(document.body, {code: "Space"});
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(request.mock.calls[0][1].body))).toEqual({source_id: "B", target_id: "A"});

  const reply = {...question, event_id: "reply", sequence: 1, student_ids: ["A", "B"],
    payload: {speaker_id: "B", recipient_ids: ["A"], content: "Compare its yellow bill.", observer_request_id: "request-1"}};
  act(() => stream?.onmessage?.({data: JSON.stringify(reply)}));
  await waitFor(() => expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent)
    .toContain("Compare its yellow bill."));
  await waitFor(() => expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent)
    .toContain("Steering delivered"));
  act(() => stream?.onopen?.());
  expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent).toContain("Steering delivered");

  fireEvent.change(screen.getByRole("slider", {name: "Replay playhead"}), {target: {value: "0"}});
  fireEvent.keyDown(document.body, {code: "Space"});
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent).toContain("Steering still goes to the current live class");
  expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent).not.toContain("Compare its yellow bill.");
  fireEvent.click(screen.getByRole("button", {name: "Follow live"}));
  await waitFor(() => expect(screen.getByRole("region", {name: "Classroom dialogue"}).textContent)
    .toContain("Compare its yellow bill."));
});

it("starts a separate mode session and retains its mode after loading the new recording", async () => {
  const manifest: RunManifest = {
    schema_version: "1.0", run_id: "demo", mode: "synthetic", label: "Demo",
    created_at: "2025-09-01T08:00:00", upstream_commit: "test", teacher: {name: "Teacher"}, concept_mapping: {},
    roster: [{student_id: "A", display_name: "Avery", initials: "A", color: "#456", attributes: {}}],
  };
  const configuration = createPreset(manifest, "pipeline");
  const next = {...manifest, run_id: "relay", label: "Demo relay", run_configuration: {experiment: configuration}};
  const post = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      post(url, JSON.parse(String(options.body)));
      return new Response(JSON.stringify(next), {status: 201});
    }
    return new Response(JSON.stringify(url === "/api/runs" ? [manifest]
      : url.endsWith("/events") ? []
      : url.includes("/relay/") ? next : manifest));
  }));
  render(<App />);
  const select = await screen.findByRole("combobox", {name: "Mode"});
  fireEvent.change(select, {target: {value: "pipeline"}});
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/demo/start",
    {configuration, execution: "synthetic"}));
  await waitFor(() => expect((screen.getByRole("combobox", {name: "Mode"}) as HTMLSelectElement).value).toBe("pipeline"));
  expect(screen.queryByRole("combobox", {name: "Run"})).toBeNull();
  expect(screen.queryByText("Start live")).toBeNull();
  expect(screen.queryByText("Config")).toBeNull();
  expect(screen.getByRole("region", {name: "Classroom dialogue"})).toBeTruthy();
});

it("opens a dedicated test view with real incoming progress and keeps the seated classroom accessible", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const lesson: RunManifest = {
    schema_version: "1.0", run_id: "lesson", mode: "recorded", label: "Lesson", concept_mapping: {},
    created_at: "2025-09-01T08:00:00", upstream_commit: "test", teacher: {name: "Teacher"},
    roster: ["A", "B", "C", "D", "E", "F"].map((id) =>
      ({student_id: id, display_name: id, initials: id, color: "#456", attributes: {}})),
    run_configuration: {runner: "classroom", execution: "live"},
  };
  const test = {...lesson, run_id: "test", mode: "live",
    run_configuration: {runner: "assessment", execution: "live", status: "preparing_test", language: "en"}};
  const post = vi.fn();
  let completed = false;
  const result = {
    schema_version: "1.0", run_id: "test", event_id: "result", sequence: 0, student_ids: ["A"],
    simulation_time: "2025-09-01T08:01:00", event_kind: "assessment", source_record_refs: [],
    payload: {student_id: "A", assessment_id: "birds", checkpoint: "final", assessment_mode: "independent",
      correct_count: 1, scorable_count: 1, expected_count: 1, attempted_count: 1, score_percent: 100,
      item_results: [{item_id: "q1", status: "correct", response: "Mallard", task_type: "classification", label: "Mallard"}]},
  };
  const finalEvents = lesson.roster.map((student, index) => ({...result,
    event_id: `result-${index}`, sequence: index, student_ids: [student.student_id],
    payload: {...result.payload, student_id: student.student_id}}));
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") { post(url); return new Response(JSON.stringify(test), {status: 201}); }
    return new Response(JSON.stringify(url === "/api/runs" ? [lesson]
      : url === "/api/classroom" ? {live_available: true}
      : url.endsWith("/events") ? completed ? finalEvents : []
      : url.endsWith("/conversations") ? {available: false, mode: completed ? "recorded" : "live",
        status: completed ? "complete" : "testing"}
      : url.includes("/test/") ? test : lesson));
  }));
  let stream: {onmessage: ((event: {data: string}) => void) | null} | undefined;
  vi.stubGlobal("EventSource", class {
    onopen = null; onerror = null; onmessage = null;
    constructor() { stream = this; }
    close() {}
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", {name: "Start test"}));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/lesson/tests"));
  await screen.findByRole("region", {name: "Independent bird test"});
  expect(screen.getByText("0/6 students finished")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Back to classroom"}));
  await waitFor(() => expect(document.querySelectorAll("[data-desk-id]")).toHaveLength(6));
  expect(new Set([...document.querySelectorAll("[data-desk-id]")].map((element) => (element as SVGElement).style.transform)).size).toBe(6);
  expect(screen.getByText("Steering off · test")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "View test"}));
  act(() => stream?.onmessage?.({data: JSON.stringify(result)}));
  await waitFor(() => expect(screen.getByText("1/6 students finished")).toBeTruthy());
  completed = true;
  await waitFor(() => expect(screen.getByText("6/6 students finished")).toBeTruthy(), {timeout: 2500});
});
