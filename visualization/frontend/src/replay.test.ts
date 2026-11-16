import {describe, expect, it} from "vitest";
import {buildAnimalEvidence, buildCognitiveOutcome, buildScoreView, classroomActivity, recordedRecipients, reconstructStates, studentMessageRoutes} from "./replay";
import {NormalizedEvent, RunManifest} from "./types";

const base: Pick<NormalizedEvent, "schema_version" | "run_id" | "simulation_time" | "student_ids" | "source_record_refs"> = {
  schema_version: "1.0",
  run_id: "test",
  simulation_time: "1",
  student_ids: ["A"],
  source_record_refs: [{path: "test"}],
};

describe("classroom activity and selected message routes", () => {
  const manifest: RunManifest = {
    schema_version: "1.0", run_id: "test", mode: "synthetic", label: "Test",
    created_at: "2025-09-01T08:00:00", upstream_commit: "test", concept_mapping: {},
    teacher: {name: "Teacher"},
    roster: ["A", "B"].map((id) => ({
      student_id: id, display_name: id, color: "#56789a", initials: id, attributes: {},
    })),
  };
  const interaction = (id: string, speaker: string, recipients: string[]): NormalizedEvent => ({
    ...base, event_id: id, sequence: 0, event_kind: "interaction",
    payload: {speaker_id: speaker, recipient_ids: recipients},
  });

  it("shows only selected student edges, including messages to the teacher", () => {
    const messages = [interaction("one", "Teacher", ["A", "B"]), interaction("two", "B", ["A"])];
    expect(studentMessageRoutes(messages, manifest, "A").map(({event, targetId}) => [event.event_id, targetId]))
      .toEqual([["one", "A"], ["two", "A"]]);
    expect(studentMessageRoutes(messages, manifest, "B")).toHaveLength(2);
    const help = {...interaction("help", "A", []), payload: {speaker_id: "A", audience_channel: "teacher"}};
    expect(recordedRecipients(help, manifest)).toEqual(["Teacher"]);
    expect(studentMessageRoutes([help], manifest, "B")).toEqual([]);
    expect(recordedRecipients({...help, payload: {...help.payload, recipient_ids: []}}, manifest)).toEqual([]);
    expect(recordedRecipients({...help, payload: {audience_channel: "student"}}, manifest)).toEqual([]);
  });

  it("previews only the next test time and rewinds test poses without leaking results", () => {
    const events: NormalizedEvent[] = [
      {...interaction("question", "Teacher", ["A"]), simulation_time: "2025-09-01T08:02:00",
        payload: {speaker_id: "Teacher", interaction_type: "question", content: "Identify the bird"}},
      {...base, event_id: "test-a", sequence: 1, simulation_time: "2025-09-01T08:10:00", event_kind: "assessment",
        payload: {checkpoint: "final", assessment_mode: "independent", student_id: "A", score_percent: 75}},
      {...base, event_id: "test-b", sequence: 2, simulation_time: "2025-09-01T08:10:00", event_kind: "assessment",
        payload: {checkpoint: "final", assessment_mode: "independent", student_id: "B"}},
      {...interaction("resume", "Teacher", ["A"]), simulation_time: "2025-09-01T08:11:00"},
    ];
    const before = classroomActivity(events, 0, "Teacher");
    expect(before.task).toBe("Teacher-led question");
    expect(before.secondsToTest).toBe(480);
    expect(before.isTest).toBe(false);
    expect(JSON.stringify(before)).not.toContain("75");
    expect(classroomActivity(events, 1, "Teacher").isTest).toBe(true);
    expect(classroomActivity(events, 2, "Teacher").isTest).toBe(true);
    expect(classroomActivity(events, 3, "Teacher").isTest).toBe(false);
    expect(classroomActivity(events, 0, "Teacher").isTest).toBe(false);
    expect(classroomActivity([], 0, "Teacher").nextTestTime).toBeUndefined();
  });
});

describe("reconstructStates", () => {
  it("merges partial snapshots and does not leak future state", () => {
    const events: NormalizedEvent[] = [
      {
        ...base,
        event_id: "one",
        sequence: 0,
        event_kind: "state_snapshot",
        payload: {
          student_id: "A",
          snapshot_scope: "full",
          concepts: [{concept_id: "zero", label: "Zero", raw_value: 0, normalized_mastery: 0}],
          misconceptions: [{misconception_id: "m", text: "mistake", status: "active"}],
        },
      },
      {
        ...base,
        event_id: "two",
        sequence: 1,
        event_kind: "state_snapshot",
        payload: {
          student_id: "A",
          snapshot_scope: "partial",
          concepts: [{concept_id: "new", label: "New", raw_value: 0.5}],
          misconceptions: [],
        },
      },
    ];
    expect(reconstructStates(events, 0).A.concepts.zero.normalized_mastery).toBe(0);
    const later = reconstructStates(events, 1).A;
    expect(later.concepts.zero).toBeDefined();
    expect(later.misconceptions.m.status).toBe("active");
    expect(reconstructStates(events, 0).A.concepts.new).toBeUndefined();
  });

  describe("comparable assessments", () => {
    const assessment = (
      event_id: string,
      sequence: number,
      student_id: string,
      checkpoint: string,
      score_percent: number,
      scorable_count = 4,
    ): NormalizedEvent => ({
      ...base,
      event_id,
      sequence,
      event_kind: "assessment",
      student_ids: [student_id],
      payload: {
        student_id,
        assessment_id: "fixed-v1",
        checkpoint,
        score_percent,
        scorable_count,
        expected_count: 4,
        assessment_mode: "independent",
      },
    });

    describe("animal classification and recall evidence", () => {
      const manifest: RunManifest = {
        schema_version: "1.0", run_id: "test", mode: "recorded", label: "Test",
        created_at: "2025-09-01T08:00:00", upstream_commit: "test", concept_mapping: {}, teacher: {name: "Teacher"},
        roster: ["A", "B"].map((id) => ({student_id: id, display_name: id, color: "#456", initials: id, attributes: {}})),
        assessment_definitions: [{assessment_id: "birds", item_definitions: [
          {item_id: "duck", label: "Mallard", task_type: "classification", image_url: "/duck.svg"},
          {item_id: "memory", label: "Bill color", task_type: "recall"},
        ]}],
      };
      const baseline: NormalizedEvent = {
        ...base, event_id: "before", sequence: 0, event_kind: "assessment",
        payload: {student_id: "A", assessment_id: "birds", checkpoint: "baseline", assessment_mode: "independent",
          expected_count: 2, scorable_count: 2, score_percent: 100,
          item_results: [{item_id: "duck", status: "correct"}, {item_id: "memory", status: "correct"}]},
      };
      const final: NormalizedEvent = {
        ...baseline, event_id: "after", sequence: 1,
        payload: {...baseline.payload, checkpoint: "final", scorable_count: 1, score_percent: 100,
          item_results: [{item_id: "duck", status: "error", error: "Image failed"}, {item_id: "memory", status: "correct"}]},
      };

      it("keeps image errors and untested students unknown, separates recall, and rewinds", () => {
        const events = [baseline, final];
        expect(buildAnimalEvidence(events, -1, manifest).items).toEqual([]);
        const before = buildAnimalEvidence(events, 0, manifest);
        expect(before.rows[0].allClassifiedCorrectly).toBe(true);
        const after = buildAnimalEvidence(events, 1, manifest);
        expect(after.rows[0].allClassifiedCorrectly).toBeNull();
        expect(after.rows[0].classification[0].status).toBe("error");
        expect(after.rows[0].recallCorrect).toBe(1);
        expect(after.rows[0].recallAlreadyCorrect).toBe(1);
        expect(after.rows[0].delayedRecall).toBe(false);
        expect(after.rows[1].cells.every((cell) => cell.status === "not_tested")).toBe(true);
        expect(buildAnimalEvidence(events, 0, manifest).rows[0].classification[0].status).toBe("correct");
        expect(buildCognitiveOutcome(events, 1, "A").assessmentGain).toBeNull();
        expect(buildCognitiveOutcome(events, 1, "A").assessmentComplete).toBe(false);
      });

      it("never compares different blueprints or double-counts a student's repeated checkpoint", () => {
        const other = {...final, payload: {...baseline.payload, assessment_id: "other", checkpoint: "final", score_percent: 50}};
        expect(buildCognitiveOutcome([baseline, other], 1, "A").assessmentGain).toBeNull();
        const view = buildScoreView([baseline, {...baseline, event_id: "retry", payload: {...baseline.payload, score_percent: 50}}], 1, manifest);
        expect(view.chartData[0].coverage).toBe("1/2");
        expect(view.chartData[0].average).toBe(50);
        const changed = buildScoreView([baseline, other], 1, manifest);
        expect(changed.chartData).toHaveLength(1);
        expect(changed.assessmentId).toBe("other");
      });

      it("does not withhold correct species identification because a separate recall answer is missing", () => {
        const result = {...final, payload: {...final.payload,
          item_results: [{item_id: "duck", status: "correct"}, {item_id: "memory", status: "missing"}]}};
        const student = buildAnimalEvidence([result], 0, manifest).rows[0];
        expect(student.allClassifiedCorrectly).toBe(true);
        expect(student.recallScored).toBe(0);
      });

      it("excludes a different item set from a class average even when the blueprint ID was reused", () => {
        const different = {...baseline, event_id: "different", payload: {...baseline.payload, student_id: "B", score_percent: 0,
          item_results: [{item_id: "duck", status: "wrong"}, {item_id: "different-question", status: "wrong"}]}};
        const view = buildScoreView([baseline, different], 1, manifest);
        expect(view.chartData[0].coverage).toBe("1/2");
        expect(view.chartData[0].average).toBe(100);
        expect(view.chartData[0].B).toBeUndefined();
      });
    });
    it("uses only complete comparable assessments in class averages and gains", () => {
    const manifest = {
      roster: [
        {student_id: "A", display_name: "A", color: "#000", initials: "A", attributes: {}},
        {student_id: "B", display_name: "B", color: "#111", initials: "B", attributes: {}},
      ],
    } as RunManifest;
    const view = buildScoreView(
      [
        assessment("a0", 0, "A", "baseline", 25),
        assessment("b0", 1, "B", "baseline", 75),
        assessment("a1", 2, "A", "final", 75),
        assessment("b1", 3, "B", "final", 50, 3),
      ],
      3,
      manifest,
    );
    expect(view.chartData[1].average).toBe(75);
    expect(view.chartData[1].coverage).toBe("1/2");
    expect(view.summaries[0].gain).toBe(50);
    expect(view.summaries[1].gain).toBeNull();
    expect(view.summaries[1].latest).toBe(50);
    });
  });

  it("builds cognitive outcomes only from evidence visible at the playhead", () => {
    const events: NormalizedEvent[] = [
      {
        ...base,
        event_id: "baseline-state",
        sequence: 0,
        event_kind: "state_snapshot",
        payload: {
          student_id: "A",
          snapshot_scope: "full",
          concepts: [{concept_id: "bird", label: "Bird ID", raw_value: 0, normalized_mastery: 0}],
          misconceptions: [{misconception_id: "m", text: "One color is enough", status: "active"}],
        },
      },
      {
        ...base,
        event_id: "change",
        sequence: 1,
        event_kind: "state_change",
        payload: {
          student_id: "A",
          concept_id: "bird",
          after: {concept_id: "bird", label: "Bird ID", raw_value: .6, normalized_mastery: 60},
          note: "Used multiple field marks.",
        },
      },
      {
        ...base,
        event_id: "resolved",
        sequence: 2,
        event_kind: "state_change",
        payload: {
          student_id: "A",
          misconception_id: "m",
          after: {misconception_id: "m", text: "One color is enough", status: "resolved"},
        },
      },
    ];

    const before = buildCognitiveOutcome(events, 0, "A");
    expect(before.concepts[0].delta).toBe(0);
    expect(before.activeMisconceptions).toBe(1);
    expect(before.recordedStateChanges).toBe(0);

    const after = buildCognitiveOutcome(events, 2, "A");
    expect(after.concepts[0].delta).toBe(60);
    expect(after.resolvedMisconceptions).toBe(1);
    expect(after.recordedStateChanges).toBe(2);
  });
});
