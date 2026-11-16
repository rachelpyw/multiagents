import {buildAnimalEvidence, buildScoreView} from "../replay";
import {NormalizedEvent, RunManifest} from "../types";

const statusLabels: Record<string, string> = {
  correct: "Correct", wrong: "Incorrect", missing: "No answer recorded",
  error: "Tool / model error", not_tested: "Not tested",
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
  const items = evidence.assessmentId ? evidence.items : manifest.assessment_definitions?.[0]?.item_definitions ?? [];
  const birds = items.filter((item) => item.task_type === "classification");
  const recall = items.filter((item) => item.task_type === "recall");
  const scores = buildScoreView(events, playhead, manifest).chartData.at(-1);
  const grade = studentId ? scores?.[studentId] : scores?.average;
  const fullyScored = evidence.rows.filter((entry) => typeof scores?.[entry.student.student_id] === "number").length;
  return (
    <section className="drawer-section animal-evidence" aria-label="Animal classification and recall">
      <div className="section-title"><h3>Test results</h3><span>{evidence.checkpoint ?? "waiting"}</span></div>
      {!evidence.assessmentId ? <p className="drawer-empty">No test results yet.</p> : <>
        <div className="test-overall-grade" role="group" aria-label="Overall grade">
          <span>Overall grade{!row && " · Class mean"}</span>
          <strong>{typeof grade === "number" ? `${grade.toFixed(1)}%` : row && !row.record ? "Awaiting result" : "Incomplete"}</strong>
          <small>{row ? typeof grade === "number" ? "All test items" : "No complete, fully scored test recorded."
            : `${fullyScored}/${manifest.roster.length} students fully scored${fullyScored < manifest.roster.length ? " · Provisional" : ""}`}</small>
        </div>
        {birds.length > 0 && <div className="test-bird-gallery" role="group" aria-label="Test birds">
          {birds.map((bird) => <figure key={bird.item_id}>
            {bird.image_url ? <img src={bird.image_url} alt={bird.image_alt ?? bird.label ?? bird.item_id} />
              : <div className="no-animal-image">No picture recorded</div>}
            <figcaption>{bird.label ?? bird.item_id}</figcaption>
          </figure>)}
        </div>}
        <h4 className="test-breakdown-title">Breakdown</h4>
        {!row && <p className="animal-counts">{allCorrect}/{tested.length} students identified all {birds.length} birds · {manifest.roster.length - tested.length} awaiting results{unknown ? ` · ${unknown} incomplete` : ""}</p>}
        {!row ? <div className="animal-matrix-scroll">
          <table className="animal-matrix test-summary-table">
            <caption>Independent test by student · select a student for individual answers</caption>
            <thead><tr><th>Student</th><th>Birds<small>out of {birds.length}</small></th>
              <th>Recall<small>out of {recall.length}</small></th><th>Result</th></tr></thead>
            <tbody>{evidence.rows.map((row) => <tr key={row.student.student_id}>
              <th scope="row"><button onClick={() => onStudent(row.student.student_id)}>{row.student.display_name}</button></th>
              <td>{row.record ? `${row.classificationCorrect}/${birds.length}` : "Waiting"}</td>
              <td>{row.record ? `${row.recallCorrect}/${recall.length}` : "Waiting"}</td>
              <td>{!row.record ? "Not tested" : row.cells.some((cell) => cell.status === "error") ? "Model error"
                : row.cells.some((cell) => cell.status === "missing") ? "Incomplete"
                : `${row.cells.filter((cell) => cell.status === "correct").length}/${row.cells.length} correct`}</td>
            </tr>)}</tbody>
          </table>
          <p className="drawer-empty">Select a student to see each picture, their answer, and the expected answer.</p>
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
            <h4>Recall · no picture or hints</h4>
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
