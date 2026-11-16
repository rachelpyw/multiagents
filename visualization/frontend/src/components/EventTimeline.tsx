import {EventKind, InteractionType, NormalizedEvent, RunManifest} from "../types";

interface Props {
  events: NormalizedEvent[];
  manifest: RunManifest;
  playhead: number;
  selectedStudent: string;
  selectedEvent?: string;
  studentFilter: string;
  typeFilter: string;
  onStudentFilter: (value: string) => void;
  onTypeFilter: (value: string) => void;
  onSelect: (event: NormalizedEvent) => void;
}

function label(event: NormalizedEvent) {
  if (event.event_kind === "interaction") {
    return `${event.payload.speaker_id} · ${event.payload.interaction_type}`;
  }
  if (event.event_kind === "assessment") {
    return `${event.payload.student_id} · ${event.payload.checkpoint} assessment`;
  }
  return `${event.payload.student_id} · ${event.event_kind.replace("_", " ")}`;
}

export function EventTimeline(props: Props) {
  const kinds: Array<EventKind | InteractionType> = ["interaction", "state_snapshot", "state_change", "assessment", "explanation", "question", "help_request", "other"];
  const visible = props.events.filter((event) => {
    const studentMatches = !props.studentFilter || event.student_ids.includes(props.studentFilter);
    const typeMatches = !props.typeFilter || event.event_kind === props.typeFilter || event.payload.interaction_type === props.typeFilter;
    return studentMatches && typeMatches;
  });
  return (
    <section className="panel timeline-panel" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <div><p className="eyebrow">Linked evidence</p><h2 id="timeline-title">Timeline</h2></div>
        <div className="filters">
          <label>Student
            <select value={props.studentFilter} onChange={(event) => props.onStudentFilter(event.target.value)}>
              <option value="">All</option>
              {props.manifest.roster.map((student) => <option key={student.student_id} value={student.student_id}>{student.display_name}</option>)}
            </select>
          </label>
          <label>Event
            <select value={props.typeFilter} onChange={(event) => props.onTypeFilter(event.target.value)}>
              <option value="">All</option>
              {kinds.map((kind) => <option key={kind} value={kind}>{kind.replace("_", " ")}</option>)}
            </select>
          </label>
        </div>
      </div>
      <ol className="timeline">
        {visible.map((event) => (
          <li key={event.event_id} className={`${event.sequence <= props.playhead ? "available" : "future"} ${props.selectedEvent === event.event_id ? "selected" : ""}`}>
            <button onClick={() => props.onSelect(event)} disabled={event.sequence > props.playhead}>
              <time>{new Date(event.simulation_time).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}</time>
              <strong>{label(event)}</strong>
              <span>{event.payload.content ?? event.payload.note ?? event.payload.evidence ?? `${event.event_kind} record`}</span>
            </button>
            {props.selectedEvent === event.event_id && (
              <div className="event-detail">
                <p>{event.payload.content}</p>
                {event.payload.before !== undefined && <pre>{JSON.stringify({before: event.payload.before, after: event.payload.after}, null, 2)}</pre>}
                <small>Source: {event.source_record_refs.map((ref) => `${ref.path}${ref.line ? `:${ref.line}` : ""}`).join(", ")}</small>
                {event.payload.classification_source && <small>Classification: {event.payload.classification_source}</small>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
