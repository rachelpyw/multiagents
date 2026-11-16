import {useEffect, useState} from "react";
import {assessmentsThrough, buildCognitiveOutcome, eventsThrough, recordedRecipients} from "../replay";
import {NormalizedEvent, RunManifest, StudentState} from "../types";
import {AssessmentEvidence} from "./AssessmentEvidence";

interface Props {
  manifest: RunManifest;
  events: NormalizedEvent[];
  playhead: number;
  selectedStudent: string;
  states: Record<string, StudentState>;
  mode: "overview" | "student" | "instructor" | "transcript";
  selectedEvent?: string;
  onMode: (mode: "overview" | "student" | "instructor" | "transcript") => void;
  onStudent: (id: string) => void;
  onEvent: (event: NormalizedEvent) => void;
  onClose: () => void;
}

const nativeEndpoints = new Set(["perceive", "retrieve", "reflect", "plan", "execute", "update_experience"]);
const endpointOf = (event: NormalizedEvent): string | undefined => {
  const endpoint = event.payload.endpoint;
  if (typeof endpoint !== "string" || !nativeEndpoints.has(endpoint) || event.payload.phase !== "cognitive") return undefined;
  const path = endpoint === "update_experience" ? "runtime/teacher/teacher.py" : `runtime/student/${endpoint}.py`;
  return event.source_record_refs.some((source) => source.path === path && source.hook === endpoint)
    ? endpoint : undefined;
};
const textOf = (event: NormalizedEvent): string =>
  event.payload.content ?? event.payload.action ?? event.payload.note ?? event.payload.evidence
  ?? (event.event_kind === "assessment" ? `${event.payload.score_percent ?? "—"}% · ${event.payload.correct_count}/${event.payload.expected_count} correct`
    : event.payload.period ?? "State recorded");

export function InsightPanel(props: Props) {
  const [trail, setTrail] = useState("all");
  const [endpoint, setEndpoint] = useState("all");
  const [outcome, setOutcome] = useState("all");
  useEffect(() => { setTrail("all"); setEndpoint("all"); setOutcome("all"); }, [props.manifest.run_id]);
  useEffect(() => { if (props.mode === "transcript") setTrail("dialogue"); }, [props.mode]);
  const teacherId = String(props.manifest.teacher.name ?? "Teacher");
  const character = props.mode === "student" ? props.selectedStudent : props.mode === "instructor" ? teacherId : "all";
  const nameOf = (id: string) => props.manifest.roster.find((student) => student.student_id === id)?.display_name ?? id;
  const visible = eventsThrough(props.events, props.playhead);
  const scoped = visible.filter((event) => character === "all" || event.student_ids.includes(character)
    || event.payload.agent_id === character || event.payload.instructor_id === character
    || event.payload.speaker_id === character || recordedRecipients(event, props.manifest).includes(character));
  const endpoints = [...new Set(scoped.flatMap((event) => {
    const native = endpointOf(event);
    return native ? [native] : [];
  }))].sort();
  const filtered = scoped.filter((event) =>
    (endpoint === "all" || endpointOf(event) === endpoint)
    && (outcome === "all" || event.event_kind === "assessment"
      && event.payload.item_results?.some((item: {status: string}) => item.status === outcome))
    && (trail === "all" || (trail === "dialogue" && event.event_kind === "interaction")
      || (trail === "decisions" && endpointOf(event) !== undefined)
      || (trail === "learning" && ["state_change", "state_snapshot", "instructor_snapshot"].includes(event.event_kind))
      || (trail === "tests" && event.event_kind === "assessment")
      || (trail === "steering" && (event.payload.observer_request_id || event.payload.steering_context_ids?.length))));
  const unfiltered = trail === "all" && endpoint === "all" && outcome === "all";
  const hasAssessment = assessmentsThrough(props.events, props.playhead).length > 0;
  const cognitive = character !== "all" && character !== teacherId
    ? buildCognitiveOutcome(props.events, props.playhead, character) : undefined;
  const state = props.states[character];
  const instructor = [...scoped].reverse().find((event) => event.event_kind === "instructor_snapshot");
  const list = [...filtered].reverse().filter((event) => !unfiltered || !["state_snapshot", "instructor_snapshot"].includes(event.event_kind));

  return <aside className="insight-drawer" aria-label="Class and student insights">
    <header className="drawer-header">
      <h2>{character === "all" ? "Class overview" : nameOf(character)}</h2>
      <button className="drawer-close" onClick={props.onClose} aria-label="Close insights">×</button>
    </header>
    <div className="insight-filters">
      <label>Character<select value={character} onChange={(event) => {
        setEndpoint("all");
        if (event.target.value === "all") props.onMode("overview");
        else if (event.target.value === teacherId) props.onMode("instructor");
        else props.onStudent(event.target.value);
      }}>
        <option value="all">Whole class</option><option value={teacherId}>{teacherId} · Instructor</option>
        {props.manifest.roster.map((student) => <option key={student.student_id} value={student.student_id}>{student.display_name}</option>)}
      </select></label>
      <label>Trail<select value={trail} onChange={(event) => setTrail(event.target.value)}>
        <option value="all">Overview + recent trail</option><option value="dialogue">Dialogue</option>
        <option value="decisions">Native calls</option><option value="learning">Learning changes</option>
        <option value="tests">Test results</option><option value="steering">User steering</option>
      </select></label>
      <label>AgentSchool function<select value={endpoint} onChange={(event) => setEndpoint(event.target.value)}>
        <option value="all">All functions</option>
        {endpoints.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
      </select></label>
      <label>Outcome<select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
        <option value="all">All outcomes</option><option value="correct">Correct</option><option value="wrong">Incorrect</option>
        <option value="error">Model error</option><option value="missing">Missing answer</option>
      </select></label>
    </div>
    <div className="drawer-scroll">
      {unfiltered && character === "all" && <>
        <div className="class-summary"><span>{props.manifest.roster.length} students</span>
          {!hasAssessment && <strong>No test yet</strong>}</div>
        {hasAssessment &&
          <AssessmentEvidence manifest={props.manifest} events={props.events} playhead={props.playhead} onStudent={props.onStudent} />}
      </>}
      {unfiltered && cognitive && <>
        <AssessmentEvidence manifest={props.manifest} events={props.events} playhead={props.playhead}
          studentId={character} onStudent={props.onStudent} />
        <section className="cognitive-summary"><h3>Cognitive outcomes</h3>
          {cognitive.concepts.map((concept) => <div className="hud-row" key={concept.conceptId}>
            <span>{concept.label}</span><strong>{concept.baseline.toFixed(1)} → {concept.current.toFixed(1)}%</strong>
          </div>)}
          {Object.values(state?.misconceptions ?? {}).map((item) =>
            <p className="misconception-note" key={item.misconception_id}>{item.text}
              {item.status !== "unknown" && <small> {item.status}</small>}</p>)}
          {!cognitive.concepts.length && !Object.keys(state?.misconceptions ?? {}).length
            && <p className="drawer-empty">No cognitive changes recorded.</p>}
          {cognitive.assessmentGain !== null && <p>Comparable test gain: {cognitive.assessmentGain.toFixed(1)} percentage points</p>}
          {cognitive.latestEvidence && <p>{cognitive.latestEvidence}</p>}
        </section>
      </>}
      {unfiltered && character === teacherId && <section className="cognitive-summary">
        <h3>Teaching state</h3>
        <p>{instructor?.payload.period?.replaceAll("_", " ") ?? "No teaching state recorded."}</p>
        {instructor?.payload.target && <p>{instructor.payload.target}</p>}
        {instructor?.payload.retrieved_experience && <details><summary>Retrieved experience</summary><p>{instructor.payload.retrieved_experience}</p></details>}
        <p className="drawer-empty">{scoped.some((event) => event.payload.endpoint === "update_experience" && event.payload.status === "completed")
          ? "Teaching experience updated." : "No completed experience update recorded."}</p>
      </section>}
      <section className="evidence-trail">
        <div className="section-title"><h3>{unfiltered ? "Recent trail" : "Evidence trail"}</h3>
          <span>{filtered.length} records</span></div>
        {!list.length && <p className="drawer-empty">No matching recorded evidence.</p>}
        <ol className="transcript-list">
          {(unfiltered ? list.slice(0, 5) : list).map((event) => <li key={event.event_id}
            className={props.selectedEvent === event.event_id ? "selected" : ""}>
            <button onClick={() => props.onEvent(event)}>
              <header><strong>{nameOf(event.payload.speaker_id ?? event.payload.agent_id ?? event.payload.student_id ?? teacherId)}</strong>
                <time>{new Date(event.simulation_time).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}</time></header>
              <p>{textOf(event)}</p><small>{endpointOf(event) && "AgentSchool · "}
                {(endpointOf(event) ?? event.payload.active_event ?? event.event_kind).replaceAll("_", " ")}</small>
            </button>
            {event.event_kind === "assessment" && !unfiltered && <ul className="filtered-results">
              {event.payload.item_results?.filter((item: {status: string}) => outcome === "all" || item.status === outcome)
                .map((item: {item_id: string; label?: string; image_url?: string; image_alt?: string; status: string; response?: string; expected_response?: string}) =>
                  <li key={item.item_id} className={`result-${item.status}`}>
                    {item.image_url && <img src={item.image_url} alt={item.image_alt ?? item.label ?? item.item_id} />}
                    <span><strong>{item.label ?? item.item_id} · {item.status === "wrong" ? "Incorrect" : item.status}</strong>
                      <small>Answer: {item.response ?? "Not recorded"} · Expected: {item.expected_response ?? "Not recorded"}</small></span>
                  </li>)}
            </ul>}
            {props.selectedEvent === event.event_id && <details className="assessment-provenance">
              <summary>Source evidence</summary>
              {event.source_record_refs.map((source, index) => <p key={index}>{source.path}{source.line ? `:${source.line}` : ""}{source.hook ? ` · ${source.hook}` : ""}</p>)}
            </details>}
          </li>)}
        </ol>
      </section>
    </div>
  </aside>;
}
