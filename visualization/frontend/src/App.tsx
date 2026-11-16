import {useEffect, useMemo, useRef, useState} from "react";
import {ClassroomView} from "./components/ClassroomView";
import {InsightPanel} from "./components/InsightPanel";
import {PlaybackControls} from "./components/PlaybackControls";
import {ExperimentToolbar} from "./components/ExperimentToolbar";
import {ArchitectureKind, ExperimentConfiguration, createPreset} from "./experiment";
import {classroomActivity, eventsThrough, reconstructStates} from "./replay";
import {NormalizedEvent, RunManifest} from "./types";

export default function App() {
  const [manifest, setManifest] = useState<RunManifest>();
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [runId, setRunId] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedStudent, setSelectedStudent] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerMode, setDrawerMode] = useState<"overview" | "student" | "instructor" | "transcript">("overview");
  const [configuration, setConfiguration] = useState<ExperimentConfiguration>();
  const [error, setError] = useState("");
  const [liveAvailable, setLiveAvailable] = useState(false);
  const [followingLive, setFollowingLive] = useState(true);
  const [conversationReady, setConversationReady] = useState(false);
  const [conversationNotice, setConversationNotice] = useState("");
  const [conversationRequest, setConversationRequest] = useState<string>();
  const [modeBusy, setModeBusy] = useState(false);
  const [testStarting, setTestStarting] = useState(false);
  const [classStarting, setClassStarting] = useState(false);
  const conversationInFlight = useRef(false);
  const currentRun = useRef(runId);
  currentRun.current = runId;

  useEffect(() => {
    Promise.all([
      fetch("/api/runs").then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to list runs"))),
      fetch("/api/classroom").then((response) => response.ok ? response.json() : Promise.reject(new Error("Classroom settings unavailable"))),
    ])
      .then(([data, settings]: [RunManifest[], {live_available?: boolean}]) => {
        setLiveAvailable(settings.live_available === true);
        const initial = data.find((run) => run.run_configuration?.language === "en")
          ?? data.find((run) => run.mode === "synthetic")
          ?? data.find((run) => !["native", "assessment"].includes(String(run.run_configuration?.runner)));
        if (initial) setRunId(initial.run_id);
        else setError("No English classroom recording or demo is available.");
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    setError("");
    setConversationReady(false);
    Promise.all([
      fetch(`/api/runs/${runId}/manifest`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Run manifest unavailable"))),
      fetch(`/api/runs/${runId}/events`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Run events unavailable"))),
    ])
      .then(([nextManifest, nextEvents]: [RunManifest, NormalizedEvent[]]) => {
        if (!active) return;
        setManifest(nextManifest);
        setEvents(nextEvents);
        setPlayhead(nextManifest.mode === "synthetic"
          ? nextManifest.run_configuration?.runner === "classroom"
            ? Math.max(0, nextEvents.findIndex((event) => event.event_kind === "interaction")) : 0
          : Math.max(0, nextEvents.length - 1));
        setPlaying(nextManifest.mode === "synthetic");
        setFollowingLive(true);
        setConversationNotice("");
        setConversationRequest(undefined);
        conversationInFlight.current = false;
        setSelectedStudent(nextManifest.roster[0]?.student_id ?? "");
        setSelectedEvent(undefined);
        setDrawerMode("overview");
        setConfiguration(nextManifest.run_configuration?.experiment
          ? nextManifest.run_configuration.experiment as ExperimentConfiguration
          : createPreset(nextManifest, "supervisor"));
      })
      .catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [runId]);

  useEffect(() => {
    if (manifest?.mode !== "live") return;
    const source = new EventSource(`/api/runs/${manifest.run_id}/stream`);
    source.onerror = () => setConversationNotice("Connection lost; reconnecting…");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as NormalizedEvent;
      setEvents((current) => current.some((item) => item.event_id === event.event_id) ? current : [...current, event]);
    };
    return () => source.close();
  }, [manifest?.run_id, manifest?.mode]);

  useEffect(() => {
    if (manifest?.mode === "live" && followingLive) {
      setPlayhead(Math.max(0, events.length - 1));
      setSelectedEvent(undefined);
    }
  }, [manifest?.mode, followingLive, events.length]);

  useEffect(() => {
    if (manifest?.mode !== "live") {
      setConversationReady(false);
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const path = `/api/runs/${manifest.run_id}/conversations`;
        const response = await fetch(conversationRequest ? `${path}/${conversationRequest}` : path);
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail ?? "Conversation status unavailable");
        if (!active || currentRun.current !== manifest.run_id) return;
        if (conversationRequest) {
          setConversationNotice(body.status === "completed" ? "Steering delivered"
            : body.status === "queued" ? "Steering queued"
            : body.status === "processing" ? "Students talking…"
            : `${body.status}: ${body.detail}`);
          if (!["queued", "processing"].includes(body.status)) {
            setConversationRequest(undefined);
            conversationInFlight.current = false;
          }
        } else {
          setConversationReady(body.available === true);
          if (body.error) setConversationNotice(body.error);
          if (body.mode === "recorded" || body.status && body.status !== manifest.run_configuration?.status) {
            if (body.mode === "recorded") {
              const finished = await fetch(`/api/runs/${manifest.run_id}/events`);
              if (!finished.ok) throw new Error("Final results unavailable");
              const finalEvents = await finished.json() as NormalizedEvent[];
              if (!active || currentRun.current !== manifest.run_id) return;
              setEvents(finalEvents);
              if (followingLive) {
                setPlayhead(Math.max(0, finalEvents.length - 1));
                setSelectedEvent(undefined);
              }
            }
            setManifest((current) => current && ({...current, mode: body.mode ?? current.mode,
              run_configuration: {...current.run_configuration, status: body.status ?? current.run_configuration?.status}}));
          }
        }
      } catch (reason) {
        if (active) {
          setConversationReady(false);
          setConversationNotice(String(reason));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [manifest?.run_id, manifest?.mode, conversationRequest, followingLive]);

  useEffect(() => {
    if (!playing || playhead >= events.length - 1) return;
    const timer = window.setTimeout(
      () => {
        setSelectedEvent(undefined);
        setPlayhead((current) => Math.min(events.length - 1, current + 1));
      },
      1000 / speed,
    );
    return () => window.clearTimeout(timer);
  }, [playing, playhead, speed, events.length]);

  useEffect(() => {
    const advanceRecordedDialogue = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      if (event.code !== "Space" || event.repeat || manifest?.mode === "live") return;
      event.preventDefault();
      const nextIndex = events.findIndex((item, index) => index > playhead && item.event_kind === "interaction");
      if (nextIndex < 0) {
        const latest = [...eventsThrough(events, playhead)].reverse().find((item) =>
          item.event_kind === "interaction" && item.student_ids.includes(selectedStudent),
        );
        if (latest) setSelectedEvent(latest.event_id);
        setConversationNotice("End of recorded dialogue. New conversations require an interactive live AgentSchool run.");
        return;
      }
      const nextEvent = events[nextIndex];
      setPlaying(false);
      setPlayhead(nextIndex);
      setSelectedEvent(nextEvent.event_id);
      const studentId = nextEvent.student_ids.find((id) =>
        manifest?.roster.some((student) => student.student_id === id),
      );
      if (studentId) setSelectedStudent(studentId);
      setDrawerMode("transcript");
      setDrawerOpen(true);
    };
    window.addEventListener("keydown", advanceRecordedDialogue);
    return () => window.removeEventListener("keydown", advanceRecordedDialogue);
  }, [events, manifest, playhead, selectedStudent]);

  const states = useMemo(() => reconstructStates(events, playhead), [events, playhead]);
  const interactions = useMemo(
    () => eventsThrough(events, playhead).filter((event) => event.event_kind === "interaction"),
    [events, playhead],
  );

  if (error) {
    return <main className="status-page"><h1>Visualization unavailable</h1><p>{error}</p><p>No synthetic fallback was loaded.</p></main>;
  }
  if (!manifest || !configuration) {
    return <main className="status-page"><h1>AgentSchool classroom</h1><p>Loading room…</p></main>;
  }

  const selectStudent = (studentId: string) => {
    setSelectedStudent(studentId);
    setDrawerMode("student");
    setDrawerOpen(true);
  };
  const requestConversation = async (targetId?: string) => {
    if (currentRun.current !== manifest.run_id) return;
    if (conversationInFlight.current) return;
    if (!followingLive || playhead < events.length - 1) {
      setConversationNotice("You are viewing history. Use Follow live before steering the current lesson.");
      return;
    }
    if (manifest.run_configuration?.runner === "assessment" || classroomActivity(events, playhead, String(manifest.teacher.name ?? "Teacher")).isTest) {
      setConversationNotice("Independent test: peer conversations and assistance are disabled.");
      return;
    }
    if (!conversationReady) {
      setConversationNotice("Steering is waiting for the next teaching round.");
      return;
    }
    if (!targetId) {
      setConversationNotice("Select a student and move near a classmate until their rings overlap, then press Space.");
      return;
    }
    conversationInFlight.current = true;
    setConversationNotice("Requesting steering…");
    try {
      const response = await fetch(`/api/runs/${manifest.run_id}/conversations`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({source_id: selectedStudent, target_id: targetId}),
      });
      const body = await response.json();
      if (currentRun.current !== manifest.run_id) return;
      if (!response.ok) throw new Error(body.detail ?? "Conversation request failed");
      setConversationRequest(body.request_id);
      setConversationNotice("Steering queued");
    } catch (reason) {
      if (currentRun.current !== manifest.run_id) return;
      conversationInFlight.current = false;
      setConversationNotice(String(reason));
    }
  };
  const selectEvent = (event: NormalizedEvent) => {
    setSelectedEvent(event.event_id);
    setDrawerOpen(true);
  };

  const startMode = async (nextConfiguration: ExperimentConfiguration, execution: "synthetic" | "live") => {
    if (modeBusy) return;
    const sourceRun = manifest.run_id;
    setModeBusy(true);
    setConversationNotice(execution === "live" ? "Starting live classroom…" : "Starting demo…");
    try {
      const response = await fetch(`/api/runs/${sourceRun}/start`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({configuration: nextConfiguration, execution}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Unable to start classroom.");
      if (currentRun.current !== sourceRun) return;
      const next = body as RunManifest;
      setRunId(next.run_id);
    } catch (reason) {
      setConversationNotice(String(reason));
    } finally {
      setModeBusy(false);
    }
  };
  const applyPreset = (architecture: ArchitectureKind) => {
    if (configuration.status === "custom" && !window.confirm("Replace the current custom draft with this preset?")) {
      return;
    }
    if (liveAvailable && manifest.run_configuration?.execution !== "live"
      && !window.confirm("Start a live classroom using your OpenAI key? Model usage is billed to your account.")) return;
    void startMode(createPreset(manifest, architecture), liveAvailable ? "live" : "synthetic");
  };

  const startTest = async () => {
    if (testStarting) return;
    setTestStarting(true);
    const sourceRun = manifest.run_id;
    try {
      const response = await fetch(`/api/runs/${sourceRun}/tests`, {method: "POST"});
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? "Unable to start test");
      if (currentRun.current !== sourceRun) return;
      setFollowingLive(true);
      setRunId((body as RunManifest).run_id);
      setDrawerMode("overview");
      setDrawerOpen(true);
    } catch (reason) {
      setConversationNotice(String(reason));
    } finally {
      setTestStarting(false);
    }
  };
  const nextClass = async () => {
    if (classStarting) return;
    setClassStarting(true);
    const sourceRun = manifest.run_id;
    try {
      const response = await fetch(`/api/runs/${sourceRun}/next-class`, {method: "POST"});
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? "Unable to start the next class");
      if (currentRun.current === sourceRun) setRunId((body as RunManifest).run_id);
    } catch (reason) {
      setConversationNotice(String(reason));
    } finally {
      setClassStarting(false);
    }
  };
  const activity = classroomActivity(events, playhead, String(manifest.teacher.name ?? "Teacher"));
  const preparingTest = manifest.run_configuration?.runner === "assessment"
    && manifest.run_configuration?.status === "preparing_test" && followingLive;
  const takingTest = manifest.run_configuration?.runner === "assessment" && manifest.mode === "live" && followingLive;
  const room = (
    <section className="room-stage">
      <ClassroomView
        manifest={manifest}
        interactions={interactions}
        activity={takingTest ? {...activity, isTest: true,
          task: preparingTest ? "Preparing independent test" : activity.isTest ? activity.task : "Independent test"} : activity}
        activePhase={configuration.phases[0]}
        selectedStudent={selectedStudent}
        selectedEvent={selectedEvent}
        conversationNotice={conversationNotice}
        conversationReady={conversationReady}
        conversationPending={Boolean(conversationRequest)}
        onStartTest={startTest}
        testStarting={testStarting || preparingTest}
        onNextClass={nextClass}
        classStarting={classStarting}
        canNextClass={activity.testComplete && manifest.mode === "recorded"
          && manifest.run_configuration?.runner === "assessment"
          && String(manifest.run_configuration?.source_run_id).startsWith("native-")
          && ["complete", "complete_with_errors"].includes(String(manifest.run_configuration?.status))}
        testCompleted={new Set(eventsThrough(events, playhead).filter((event) => event.event_kind === "assessment").map((event) => event.payload.student_id)).size}
        canStartTest={["classroom", "native"].includes(String(manifest.run_configuration?.runner)) && manifest.run_configuration?.execution === "live"}
        onTalk={requestConversation}
        followingLive={followingLive}
        onFollowLive={() => { setFollowingLive(true); setConversationNotice(""); setPlayhead(Math.max(0, events.length - 1)); }}
        onStudent={selectStudent}
        onEvent={selectEvent}
      />
      <PlaybackControls
        playing={playing}
        playhead={playhead}
        max={events.length - 1}
        speed={speed}
        onPlaying={setPlaying}
        onPlayhead={(index) => {
          setFollowingLive(false);
          setSelectedEvent(undefined);
          setPlayhead(index);
        }}
        onSpeed={setSpeed}
      />
    </section>
  );

  return (
    <main className="game-shell">
      <ExperimentToolbar configuration={configuration} onPreset={applyPreset}
        busy={modeBusy || testStarting || classStarting || manifest.run_configuration?.runner === "assessment" && manifest.mode === "live"} />
      <div className={`game-workspace ${drawerOpen ? "drawer-is-open" : "drawer-is-closed"}`}>
        <div className="builder-main room">{room}</div>

        {drawerOpen ? (
          <InsightPanel
            manifest={manifest}
            events={events}
            playhead={playhead}
            selectedStudent={selectedStudent}
            states={states}
            mode={drawerMode}
            selectedEvent={selectedEvent}
            onMode={setDrawerMode}
            onStudent={selectStudent}
            onEvent={selectEvent}
            onClose={() => setDrawerOpen(false)}
          />
        ) : (
          <button className="drawer-open-button" onClick={() => setDrawerOpen(true)} aria-label="Open class insights">◀ <span>Insights</span></button>
        )}
      </div>
    </main>
  );
}
