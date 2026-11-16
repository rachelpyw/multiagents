import {AssessmentItemDefinition, AssessmentItemResult, NormalizedEvent, RunManifest, StudentState} from "./types";

export interface CognitiveOutcome {
  concepts: {
    conceptId: string;
    label: string;
    baseline: number;
    current: number;
    delta: number;
  }[];
  activeMisconceptions: number;
  resolvedMisconceptions: number;
  recordedStateChanges: number;
  assessmentBaseline: number | null;
  assessmentLatest: number | null;
  assessmentGain: number | null;
  assessmentComplete: boolean;
  latestEvidence?: string;
}

export function eventsThrough(events: NormalizedEvent[], playhead: number): NormalizedEvent[] {
  return events.slice(0, Math.max(0, playhead + 1));
}

export function lessonPictures(interactions: NormalizedEvent[], manifest: RunManifest, dialogue?: NormalizedEvent) {
  const normalize = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const items = (manifest.assessment_definitions ?? []).flatMap((definition) => definition.item_definitions ?? [])
    .filter((item): item is AssessmentItemDefinition & {image_url: string} =>
      item.task_type === "classification" && typeof item.image_url === "string");
  const index = interactions.findIndex((event) => event.event_id === dialogue?.event_id);
  for (const event of interactions.slice(0, index + 1).reverse()) {
    if (typeof event.payload.lesson_image_url === "string") {
      return [{image_url: event.payload.lesson_image_url,
        image_alt: String(event.payload.lesson_image_alt ?? "Lesson illustration"), label: ""}];
    }
    const text = normalize(String(event.payload.content ?? ""));
    const matching = items.filter((item) => {
      const names = [item.label, ...(item.answer_aliases ?? []), item.label?.split(/\s+/).at(-1)];
      return names.some((name) => name && [name, `${name}s`, name.replace(/goose$/i, "geese")]
        .some((variant) => text.includes(normalize(variant))));
    });
    if (matching.length) {
      return [...new Map(matching.map((item) => [item.image_url, {
        image_url: item.image_url, image_alt: item.image_alt ?? item.label ?? "Lesson bird illustration",
        label: item.label ?? "",
      }])).values()];
    }
  }
  return [];
}

export function recordedRecipients(event: NormalizedEvent, manifest: RunManifest): string[] {
  const knownIds = new Set([
    String(manifest.teacher.name ?? "Teacher"),
    ...manifest.roster.map((student) => student.student_id),
  ]);
  if (Array.isArray(event.payload.recipient_ids)) {
    return [...new Set<string>(event.payload.recipient_ids)].filter((id) => knownIds.has(id));
  }
  // The teacher channel has one known recipient; class/group channels are not delivery receipts.
  return event.payload.audience_channel === "teacher"
    ? [String(manifest.teacher.name ?? "Teacher")]
    : [];
}

export function studentMessageRoutes(
  interactions: NormalizedEvent[], manifest: RunManifest, studentId: string,
) {
  return interactions.flatMap((event) => recordedRecipients(event, manifest)
    .filter((targetId) => event.payload.speaker_id === studentId || targetId === studentId)
    .map((targetId) => ({event, targetId})));
}

export function classroomActivity(events: NormalizedEvent[], playhead: number, teacherId: string) {
  const visible = eventsThrough(events, playhead);
  const current = visible.at(-1);
  const test = [...visible].reverse().find((event) =>
    event.event_kind === "assessment"
    && event.payload.assessment_mode === "independent"
    && event.simulation_time === current?.simulation_time,
  );
  const activity = [...visible].reverse().find((event) =>
    event.event_kind === "interaction" || event.event_kind === "instructor_snapshot"
    || (event.event_kind === "agent_action" && event.payload.agent_id === teacherId),
  );
  const nextTest = current ? events.slice(playhead + 1).find((event) =>
    event.event_kind === "assessment"
    && event.payload.assessment_mode === "independent"
    && Date.parse(event.simulation_time) > Date.parse(current.simulation_time),
  ) : undefined;
  const secondsToTest = nextTest && current
    ? Math.max(0, Math.round((Date.parse(nextTest.simulation_time) - Date.parse(current.simulation_time)) / 1000))
    : null;
  const task = activity?.event_kind === "interaction"
    ? `${activity.payload.speaker_id === teacherId ? "Teacher-led" : "Student"} ${
      activity.payload.interaction_type === "help_request" ? "help request"
        : activity.payload.interaction_type ?? "discussion"}`
    : activity?.payload.content ?? activity?.payload.action ?? activity?.payload.period ?? "Class preparation";
  return {
    time: current?.simulation_time,
    isTest: Boolean(test) || activity?.payload.phase === "test",
    testComplete: activity?.payload.phase === "test_complete",
    task: test ? `${test.payload.checkpoint} independent test` : task,
    nextTestTime: nextTest?.simulation_time,
    secondsToTest,
  };
}

export function reconstructStates(
  events: NormalizedEvent[],
  playhead: number,
): Record<string, StudentState> {
  const states: Record<string, StudentState> = {};
  const stateFor = (studentId: string) =>
    (states[studentId] ??= {concepts: {}, misconceptions: {}, persona: {}, changes: []});

  for (const event of eventsThrough(events, playhead)) {
    if (event.event_kind === "state_snapshot") {
      const payload = event.payload;
      const state = stateFor(payload.student_id);
      if (payload.snapshot_scope === "full") {
        state.concepts = {};
        state.misconceptions = {};
      }
      for (const concept of payload.concepts ?? []) {
        state.concepts[concept.concept_id] = concept;
      }
      for (const misconception of payload.misconceptions ?? []) {
        state.misconceptions[misconception.misconception_id] = misconception;
      }
      state.persona = {...state.persona, ...(payload.persona ?? {})};
      state.lastUpdate = event;
    }
    if (event.event_kind === "state_change") {
      const payload = event.payload;
      const state = stateFor(payload.student_id);
      if (payload.concept_id && payload.after) {
        state.concepts[payload.concept_id] = {
          concept_id: payload.concept_id,
          label: payload.after.label ?? payload.concept_id,
          raw_value: payload.after.raw_value ?? null,
          ...payload.after,
        };
      }
      if (payload.misconception_id && payload.after) {
        state.misconceptions[payload.misconception_id] = {
          misconception_id: payload.misconception_id,
          text: payload.after.text ?? "Not recorded",
          status: payload.after.status ?? "unknown",
          ...payload.after,
        };
      }
      state.changes.push(event);
      state.lastUpdate = event;
    }
  }
  return states;
}

export function assessmentsThrough(events: NormalizedEvent[], playhead: number) {
  return eventsThrough(events, playhead).filter(
    (event) => event.event_kind === "assessment" && event.payload.assessment_mode === "independent",
  );
}

export function buildAnimalEvidence(events: NormalizedEvent[], playhead: number, manifest: RunManifest) {
  const assessments = assessmentsThrough(events, playhead);
  const latest = assessments.at(-1);
  const assessmentId: string | undefined = latest?.payload.assessment_id;
  const checkpoint: string | undefined = latest?.payload.checkpoint;
  const cohort = assessments.filter((event) =>
    event.payload.assessment_id === assessmentId && event.payload.checkpoint === checkpoint);
  const records = new Map(cohort.map((event) => [event.payload.student_id, event]));
  const definitions = manifest.assessment_definitions?.find((item) => item.assessment_id === assessmentId);
  const items = new Map<string, AssessmentItemDefinition>(
    (definitions?.item_definitions ?? []).map((item) => [item.item_id, item]),
  );
  for (const event of cohort) {
    const results: AssessmentItemResult[] = event.payload.item_results ?? [];
    for (const item of results) {
      if (!items.has(item.item_id)) items.set(item.item_id, {
        item_id: item.item_id, label: item.label, task_type: item.task_type,
        prompt: item.prompt, image_url: item.image_url, image_alt: item.image_alt,
        expected_response: item.expected_response,
      });
    }
  }
  const itemList = [...items.values()];
  const rows = manifest.roster.map((student) => {
    const record = records.get(student.student_id);
    const results: AssessmentItemResult[] = record?.payload.item_results ?? [];
    const baseline = record ? assessments.slice(0, assessments.indexOf(record) + 1).reverse().find((event) =>
      event.payload.student_id === student.student_id
      && event.payload.assessment_id === assessmentId
      && event.payload.checkpoint === "baseline") : undefined;
    const baselineResults: AssessmentItemResult[] = baseline?.payload.item_results ?? [];
    const cells = itemList.map((item) => {
      const result = results.find((result) => result.item_id === item.item_id);
      return {
        item, result,
        status: record ? result?.status ?? "missing" : "not_tested",
        baselineStatus: baselineResults.find((result) => result.item_id === item.item_id)?.status,
      };
    });
    const classification = cells.filter((cell) => cell.item.task_type === "classification");
    const recall = cells.filter((cell) => cell.item.task_type === "recall");
    const classificationCorrect = classification.filter((cell) => cell.status === "correct").length;
    const classificationScored = classification.filter((cell) => ["correct", "wrong"].includes(cell.status)).length;
    const fullyDescribed = record && itemList.length === record.payload.expected_count
      && itemList.every((item) => item.task_type)
      && new Set(results.map((item) => item.item_id)).size === results.length;
    return {
      student, record, cells, classification, recall, classificationCorrect, classificationScored,
      allClassifiedCorrectly: !record || !classification.length ? null
        : classification.some((cell) => cell.status === "wrong") ? false
        : fullyDescribed && classification.every((cell) => cell.status === "correct") ? true : null,
      recallCorrect: recall.filter((cell) => cell.status === "correct").length,
      recallScored: recall.filter((cell) => ["correct", "wrong"].includes(cell.status)).length,
      recallAlreadyCorrect: recall.filter((cell) => cell.status === "correct" && cell.baselineStatus === "correct").length,
      delayedRecall: recall.some((cell) => ["correct", "wrong"].includes(cell.status))
        && record?.payload.test_timing === "delayed"
        && typeof record.payload.retention_delay_seconds === "number"
        && record.payload.retention_delay_seconds > 0,
    };
  });
  return {assessmentId, checkpoint, items: itemList, rows};
}

function completeAssessment(event: NormalizedEvent | undefined): boolean {
  return Boolean(event && event.payload.expected_count > 0
    && event.payload.scorable_count === event.payload.expected_count
    && typeof event.payload.score_percent === "number");
}

function comparableAssessments(baseline: NormalizedEvent | undefined, latest: NormalizedEvent | undefined): boolean {
  if (!baseline || !latest || !completeAssessment(baseline) || !completeAssessment(latest)
    || !baseline.payload.assessment_id || baseline.payload.assessment_id !== latest.payload.assessment_id
    || baseline.payload.expected_count !== latest.payload.expected_count) return false;
  const ids = (event: NormalizedEvent) =>
    JSON.stringify((event.payload.item_results ?? []).map((item: AssessmentItemResult) => item.item_id).sort());
  return ids(baseline) === ids(latest);
}

export function buildCognitiveOutcome(
  events: NormalizedEvent[],
  playhead: number,
  studentId: string,
): CognitiveOutcome {
  const visible = eventsThrough(events, playhead);
  const baselineConcepts = new Map<string, {label: string; value: number}>();
  for (const event of visible) {
    if (event.event_kind !== "state_snapshot" || event.payload.student_id !== studentId) continue;
    for (const concept of event.payload.concepts ?? []) {
      if (
        !baselineConcepts.has(concept.concept_id)
        && typeof concept.normalized_mastery === "number"
      ) {
        baselineConcepts.set(concept.concept_id, {
          label: concept.label ?? concept.concept_id,
          value: concept.normalized_mastery,
        });
      }
    }
  }

  const state = reconstructStates(events, playhead)[studentId];
  const concepts = Object.values(state?.concepts ?? {}).flatMap((concept) => {
    const baseline = baselineConcepts.get(concept.concept_id);
    if (!baseline || typeof concept.normalized_mastery !== "number") return [];
    return [{
      conceptId: concept.concept_id,
      label: concept.label,
      baseline: baseline.value,
      current: concept.normalized_mastery,
      delta: concept.normalized_mastery - baseline.value,
    }];
  });
  const misconceptions = Object.values(state?.misconceptions ?? {});
  const stateChanges = visible.filter(
    (event) => event.event_kind === "state_change" && event.payload.student_id === studentId,
  );
  const assessments = visible.filter(
    (event) =>
      event.event_kind === "assessment"
      && event.payload.student_id === studentId
      && event.payload.assessment_mode === "independent"
      && typeof event.payload.score_percent === "number",
  );
  const latestAssessment = assessments.at(-1);
  const baselineAssessment = assessments.find((event) => event.payload.checkpoint === "baseline"
    && event.payload.assessment_id === latestAssessment?.payload.assessment_id);
  const assessmentBaseline = baselineAssessment?.payload.score_percent ?? null;
  const assessmentLatest = latestAssessment?.payload.score_percent ?? null;
  const latestChange = stateChanges.at(-1);

  return {
    concepts,
    activeMisconceptions: misconceptions.filter((item) => item.status === "active").length,
    resolvedMisconceptions: misconceptions.filter((item) => item.status === "resolved").length,
    recordedStateChanges: stateChanges.length,
    assessmentBaseline,
    assessmentLatest,
    assessmentComplete: completeAssessment(latestAssessment),
    assessmentGain: assessmentBaseline !== null && assessmentLatest !== null
      && comparableAssessments(baselineAssessment, latestAssessment)
      ? assessmentLatest - assessmentBaseline
      : null,
    latestEvidence: latestChange?.payload.note ?? latestChange?.payload.evidence,
  };
}

export function buildScoreView(events: NormalizedEvent[], playhead: number, manifest: RunManifest) {
  const visibleAssessments = assessmentsThrough(events, playhead);
  const assessmentId = visibleAssessments.at(-1)?.payload.assessment_id;
  const latestRecords = new Map<string, NormalizedEvent>();
  for (const event of visibleAssessments) {
    if (event.payload.assessment_id !== assessmentId
      || !manifest.roster.some((student) => student.student_id === event.payload.student_id)) continue;
    const key = JSON.stringify([event.payload.checkpoint, event.payload.student_id]);
    latestRecords.delete(key);
    latestRecords.set(key, event);
  }
  const assessments = [...latestRecords.values()];
  const checkpoints = [...new Set(assessments.map((event) => event.payload.checkpoint))];
  const chartData = checkpoints.map((checkpoint) => {
    const row: Record<string, string | number | null> = {checkpoint};
    const scores = assessments.filter(
      (event) => event.payload.checkpoint === checkpoint && event.payload.score_percent !== null,
    );
    const reference = scores.find(completeAssessment);
    const comparable = scores.filter((event) => comparableAssessments(reference, event));
    for (const event of comparable) row[event.payload.student_id] = event.payload.score_percent;
    row.average = comparable.length
      ? comparable.reduce((sum, event) => sum + event.payload.score_percent, 0) / comparable.length
      : null;
    row.coverage = `${comparable.length}/${manifest.roster.length}`;
    return row;
  });
  const summaries = manifest.roster.map((student) => {
    const records = assessments.filter(
      (event) => event.payload.student_id === student.student_id && event.payload.score_percent !== null,
    );
    const baseline = records.find((event) => event.payload.checkpoint === "baseline")?.payload.score_percent;
    const latest = records.at(-1)?.payload.score_percent;
    const baselineRecord = records.find((event) => event.payload.checkpoint === "baseline");
    const finalRecord = records.find((event) => event.payload.checkpoint === "final");
    const gain = baselineRecord && finalRecord && comparableAssessments(baselineRecord, finalRecord)
      ? finalRecord.payload.score_percent - baselineRecord.payload.score_percent
      : null;
    return {student, baseline, latest, gain, count: records.length};
  });
  return {assessments, chartData, summaries, assessmentId};
}
