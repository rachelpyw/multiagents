export type RunMode = "recorded" | "live" | "synthetic";
export type EventKind = "interaction" | "state_snapshot" | "state_change" | "assessment" | "agent_action" | "instructor_snapshot";
export type InteractionType = "explanation" | "question" | "help_request" | "other";

export interface StudentManifest {
  student_id: string;
  display_name: string;
  color: string;
  initials: string;
  attributes: Record<string, unknown>;
}

export interface AssessmentItemDefinition {
  item_id: string;
  label?: string | null;
  prompt?: string | null;
  task_type?: "classification" | "recall" | "other";
  image_url?: string | null;
  image_alt?: string | null;
  expected_response?: string | null;
}

export interface AssessmentItemResult extends AssessmentItemDefinition {
  status: "correct" | "wrong" | "missing" | "error";
  response?: string | null;
  error?: string | null;
}

export interface AssessmentDefinition {
  assessment_id: string;
  items?: number;
  mode?: string;
  item_definitions?: AssessmentItemDefinition[];
}

export interface RunManifest {
  schema_version: "1.0";
  run_id: string;
  mode: RunMode;
  label: string;
  created_at: string;
  upstream_commit: string;
  roster: StudentManifest[];
  teacher: Record<string, unknown>;
  concept_mapping: Record<string, string>;
  assessment_definitions?: AssessmentDefinition[];
  run_configuration?: Record<string, unknown>;
}

export interface SourceRecordRef {
  path: string;
  line?: number;
  hook?: string;
}

export interface NormalizedEvent {
  schema_version: "1.0";
  run_id: string;
  event_id: string;
  sequence: number;
  simulation_time: string;
  event_kind: EventKind;
  student_ids: string[];
  source_record_refs: SourceRecordRef[];
  payload: Record<string, any>;
}

export interface ConceptState {
  concept_id: string;
  label: string;
  raw_value: number | string | null;
  raw_unit?: string;
  normalized_mastery?: number | null;
  mapping?: string;
  evidence?: string;
}

export interface MisconceptionState {
  misconception_id: string;
  concept_id?: string;
  text: string;
  status: "active" | "resolved" | "unknown";
}

export interface StudentState {
  concepts: Record<string, ConceptState>;
  misconceptions: Record<string, MisconceptionState>;
  persona: Record<string, unknown>;
  lastUpdate?: NormalizedEvent;
  changes: NormalizedEvent[];
}
