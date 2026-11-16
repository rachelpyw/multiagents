import {Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from "recharts";
import {buildScoreView} from "../replay";
import {NormalizedEvent, RunManifest} from "../types";

interface Props {
  events: NormalizedEvent[];
  playhead: number;
  manifest: RunManifest;
  selectedStudent: string;
  onStudent: (id: string) => void;
}

export function ScoreChart({events, playhead, manifest, selectedStudent, onStudent}: Props) {
  const {chartData, summaries} = buildScoreView(events, playhead, manifest);
  return (
    <section className="panel score-panel" aria-labelledby="score-title">
      <div className="panel-heading">
        <div><p className="eyebrow">Simulated assessment performance</p><h2 id="score-title">Independent outcomes</h2></div>
        <span className="coverage">{chartData.at(-1)?.coverage ?? `0/${manifest.roster.length}`} contributing</span>
      </div>
      {chartData.length === 0 ? <p className="empty">No independent assessment recorded at this point.</p> : (
        <div className="chart" aria-hidden="true">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <XAxis dataKey="checkpoint" />
              <YAxis domain={[0, 100]} unit="%" />
              <Tooltip />
              {manifest.roster.map((student) => (
                <Line
                  key={student.student_id}
                  dataKey={student.student_id}
                  stroke={student.color}
                  strokeWidth={student.student_id === selectedStudent ? 4 : 1.5}
                  opacity={student.student_id === selectedStudent ? 1 : 0.3}
                  connectNulls={false}
                />
              ))}
              <Line dataKey="average" stroke="#172333" strokeWidth={4} strokeDasharray="8 4" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <caption>Assessment scores available at the current replay point</caption>
          <thead><tr><th>Student</th><th>Baseline</th><th>Latest</th><th>Change (pp)</th><th>Assessments</th></tr></thead>
          <tbody>
            {summaries.map(({student, baseline, latest, gain, count}) => (
              <tr key={student.student_id} className={student.student_id === selectedStudent ? "selected" : ""} onClick={() => onStudent(student.student_id)}>
                <th><span className="color-dot" style={{background: student.color}} />{student.display_name}</th>
                <td>{baseline ?? "Missing"}</td><td>{latest ?? "Missing"}</td><td>{gain === null ? "Not comparable" : `${gain > 0 ? "+" : ""}${gain}`}</td><td>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
