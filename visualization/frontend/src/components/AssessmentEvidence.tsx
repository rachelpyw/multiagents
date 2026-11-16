import {buildAnimalEvidence} from "../replay";
import {NormalizedEvent, RunManifest} from "../types";

const statusLabels: Record<string, string> = {
  correct: "Correct", wrong: "Incorrect", missing: "No answer recorded",
  error: "Tool / model error", not_tested: "Not tested",
};
const statusIcons: Record<string, string> = {
  correct: "+", wrong: "x", missing: "?", error: "!", not_tested: "-",
};

interface Props {
  manifest: RunManifest;
  events: NormalizedEvent[];
  playhead: number;
  studentId?: string;
  onStudent: (id: string) => void;
}

export function AssessmentEvidence({manifest, events, playhead, studentId, onStudent}: Props) {
  const evidence = buildAnimalEvidence(events, playhead, manifest);
  const row = evidence.rows.find((row) => row.student.student_id === studentId);
  const tested = evidence.rows.filter((row) => row.record);
  const allCorrect = tested.filter((row) => row.allClassifiedCorrectly === true).length;
  const unknown = tested.filter((row) => row.allClassifiedCorrectly === null).length;
  return (
    <section className="drawer-section animal-evidence" aria-label="Animal classification and recall">
      <div className="section-title"><h3>Test results</h3><span>{evidence.checkpoint ?? "waiting"}</span></div>
      {!evidence.assessmentId ? <p className="drawer-empty">No test results yet.</p> : <>
        {!row && <p className="animal-counts">{allCorrect}/{tested.length} all species correct · {manifest.roster.length - tested.length} untested{unknown ? ` · ${unknown} incomplete` : ""}</p>}
        {!row ? <div className="animal-matrix-scroll">
          <table className="animal-matrix">
            <caption>Independent test by student · {evidence.checkpoint}</caption>
            <thead><tr><th>Student</th>{evidence.items.map((item) => <th key={item.item_id}>
              {item.image_url && <img src={item.image_url} alt={item.image_alt ?? item.label ?? item.item_id} />}
              <span>{item.label ?? item.item_id}</span><small>{item.task_type === "recall" ? "Recall" : item.task_type === "classification" ? "Identify" : "Item type not recorded"}</small>
            </th>)}</tr></thead>
            <tbody>{evidence.rows.map((row) => <tr key={row.student.student_id}>
              <th scope="row"><button onClick={() => onStudent(row.student.student_id)}>{row.student.display_name}</button></th>
              {row.cells.map((cell) => <td key={cell.item.item_id} className={`result-${cell.status}`}
                title={`${row.student.display_name}: ${cell.item.label ?? cell.item.item_id} - ${statusLabels[cell.status]}`}>
                <span aria-hidden="true">{statusIcons[cell.status]}</span><small>{statusLabels[cell.status]}</small>
              </td>)}
            </tr>)}</tbody>
          </table>
        </div> : <>
          <p className="animal-counts"><strong>{row.classificationCorrect}/{row.classification.length || "?"} species correct</strong> · {row.classificationScored} scored</p>
          <div className="animal-cards">{row.classification.map((cell) => <article key={cell.item.item_id}
            className={`animal-result result-${cell.status}`} aria-label={`${cell.item.label ?? cell.item.item_id}: ${statusLabels[cell.status]}`}>
            {cell.item.image_url ? <img src={cell.item.image_url} alt={cell.item.image_alt ?? cell.item.label ?? cell.item.item_id} />
              : <div className="no-animal-image">No picture recorded</div>}
            <div><h4>{cell.item.label ?? cell.item.item_id}</h4>
              <strong>{statusLabels[cell.status]}</strong>
              <p>Student answer: {cell.result?.response ?? "Answer text not recorded"}</p>
              <p>Expected: {cell.item.expected_response ?? "Not recorded"}</p>
              {cell.result?.error && <small>{cell.result.error}</small>}
            </div>
          </article>)}</div>
          {!row.classification.length && <p className="drawer-empty">This record does not describe any classification items. Pictures and animal identities cannot be inferred from a score.</p>}
          <div className="recall-evidence">
            <h4>Recall</h4>
            <p>{!row.record || !row.recallScored ? "No scorable independent recall answer is recorded."
              : `${row.recallCorrect}/${row.recall.length} recall items correct (${row.recallScored} scored).`}</p>
            {row.recall.map((cell) => <p key={cell.item.item_id}>{cell.item.prompt ?? cell.item.label ?? cell.item.item_id}
              <br /><strong>{statusLabels[cell.status]}</strong> · Answer: {cell.result?.response ?? "not recorded"}
              {cell.item.expected_response && <> · Expected: {cell.item.expected_response}</>}
            </p>)}
            {evidence.checkpoint === "baseline" ? <small>Before lesson</small>
              : row.delayedRecall ? <small>Delay: {row.record?.payload.retention_delay_seconds}s</small>
              : <small>No delayed recall test</small>}
            {row.recallAlreadyCorrect > 0 && evidence.checkpoint !== "baseline" &&
              <p>{row.recallAlreadyCorrect} already correct before the lesson.</p>}
          </div>
          {row.record && <details className="assessment-provenance"><summary>Recorded test evidence</summary>
            <p>{row.record.event_id} · {row.record.simulation_time} · {row.record.payload.assessment_mode}</p>
            <p>{row.record.source_record_refs.map((source) => `${source.path}${source.line ? `:${source.line}` : ""}`).join(", ")}</p>
          </details>}
        </>}
      </>}
    </section>
  );
}
