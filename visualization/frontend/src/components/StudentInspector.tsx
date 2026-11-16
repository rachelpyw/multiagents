import {StudentManifest, StudentState} from "../types";

interface Props {
  student: StudentManifest;
  state?: StudentState;
}

function show(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function StudentInspector({student, state}: Props) {
  const concepts = Object.values(state?.concepts ?? {});
  const misconceptions = Object.values(state?.misconceptions ?? {});
  return (
    <aside className="panel inspector" aria-labelledby="inspector-title">
      <p className="eyebrow">State at playhead</p>
      <h2 id="inspector-title">{student.display_name}</h2>
      <dl className="persona-list">
        {Object.entries({...student.attributes, ...state?.persona}).map(([key, value]) => (
          <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{show(value)}</dd></div>
        ))}
      </dl>
      <h3>Concept knowledge</h3>
      {concepts.length === 0 ? <p className="empty">Not recorded</p> : concepts.map((concept) => (
        <article key={concept.concept_id} className="concept-card">
          <div><strong>{concept.label}</strong><span>{concept.normalized_mastery ?? "Not recorded"}{concept.normalized_mastery !== null && concept.normalized_mastery !== undefined ? "%" : ""}</span></div>
          <progress max={100} value={concept.normalized_mastery ?? 0} aria-label={`${concept.label} mastery`} />
          <small>Raw: {show(concept.raw_value)} {concept.raw_unit ?? ""}</small>
          {concept.mapping && <small>{concept.mapping}</small>}
        </article>
      ))}
      <h3>Misconceptions</h3>
      {misconceptions.length === 0 ? <p className="empty">None recorded</p> : (
        <ul className="misconceptions">
          {misconceptions.map((item) => <li key={item.misconception_id}><span className={`status ${item.status}`}>{item.status}</span>{item.text}</li>)}
        </ul>
      )}
      <h3>Latest update</h3>
      {state?.lastUpdate ? (
        <div className="provenance">
          <time>{state.lastUpdate.simulation_time}</time>
          <span>{state.lastUpdate.source_record_refs.map((ref) => `${ref.path}${ref.line ? `:${ref.line}` : ""}`).join(", ")}</span>
          {state.changes.at(-1)?.payload.note && <p>{state.changes.at(-1)?.payload.note}</p>}
        </div>
      ) : <p className="empty">Not recorded</p>}
    </aside>
  );
}
