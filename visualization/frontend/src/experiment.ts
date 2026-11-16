import {RunManifest} from "./types";
import birdLesson from "../../fixtures/bird-identification-v2.json";

export type ArchitectureKind = "supervisor" | "pipeline" | "decentralized" | "blackboard";

export interface ExperimentAgent {
  agent_id: string;
  display_name: string;
  role: string;
  objective: string;
  allowed_actions: string[];
  observable_resources: string[];
}

export interface DirectedRoute {
  source_id: string;
  target_id: string;
  channel: string;
  allowed: boolean;
}

export interface LessonPhase {
  phase_id: string;
  label: string;
  architecture: ArchitectureKind;
  rounds: number;
  speaking_policy: "coordinator" | "ordered" | "round_robin" | "open";
  coordinator_id?: string;
  peer_communication: boolean;
  pipeline_order: string[];
  artifact_name?: string;
  routes: DirectedRoute[];
  blackboard?: {
    readers: string[];
    writers: string[];
    teacher_review_required: boolean;
  };
}

export interface ExperimentConfiguration {
  config_id: string;
  label: string;
  status: "preset" | "custom";
  agents: ExperimentAgent[];
  lesson_content: string;
  resources: string[];
  shared_artifacts: string[];
  phases: LessonPhase[];
  budget: {
    time_minutes?: number;
    max_turns?: number;
    max_messages?: number;
    max_tokens?: number;
  };
  assessment: {
    blueprint_id: string;
    fixed_items: boolean;
    independent: boolean;
    assistance_disabled: boolean;
  };
}

const architectureLabels: Record<ArchitectureKind, string> = {
  supervisor: "Teacher-led · Supervisor",
  pipeline: "Sequential · Relay",
  decentralized: "Peer network",
  blackboard: "Shared blackboard",
};

export const architectureDescriptions: Record<ArchitectureKind, string> = {
  supervisor: "A coordinator delegates work and collects reports. Peer routes are off by default.",
  pipeline: "A versioned evidence artifact passes through an ordered sequence.",
  decentralized: "Agents communicate only along explicitly allowed peer routes.",
  blackboard: "Agents contribute versioned claims and evidence under read/write permissions.",
};

export function createPreset(manifest: RunManifest, architecture: ArchitectureKind): ExperimentConfiguration {
  const teacherId = String(manifest.teacher.name ?? "Teacher");
  const agents: ExperimentAgent[] = [
    {
      agent_id: teacherId,
      display_name: teacherId,
      role: architecture === "supervisor" ? "coordinator" : "teacher",
      objective: "Guide the lesson without exposing private student memory.",
      allowed_actions: ["explain", "question", "request_help", "write_board"],
      observable_resources: ["lesson_content", "shared_artifacts"],
    },
    ...manifest.roster.map((student, index) => ({
      agent_id: student.student_id,
      display_name: student.display_name,
      role: architecture === "pipeline" ? `stage_${index + 1}` : "student",
      objective: "Contribute evidence and preserve uncertainty.",
      allowed_actions: ["explain", "question", "request_help", "write_board"],
      observable_resources: ["lesson_content"],
    })),
  ];
  const studentIds = manifest.roster.map((student) => student.student_id);
  const routes: DirectedRoute[] = [];
  if (architecture === "supervisor") {
    for (const studentId of studentIds) {
      routes.push(
        {source_id: teacherId, target_id: studentId, channel: "class", allowed: true},
        {source_id: studentId, target_id: teacherId, channel: "class", allowed: true},
      );
    }
  }
  if (architecture === "decentralized") {
    for (const studentId of studentIds) {
      routes.push({source_id: teacherId, target_id: studentId, channel: "class", allowed: true},
        {source_id: studentId, target_id: teacherId, channel: "class", allowed: true});
    }
    studentIds.forEach((studentId, index) => {
      const next = studentIds[(index + 1) % studentIds.length];
      routes.push(
        {source_id: studentId, target_id: next, channel: "class", allowed: true},
        {source_id: next, target_id: studentId, channel: "class", allowed: true},
      );
    });
  }
  const order = [teacherId, ...studentIds];
  if (architecture === "pipeline") {
    order.slice(0, -1).forEach((agentId, index) => {
      routes.push({
        source_id: agentId,
        target_id: order[index + 1],
        channel: "artifact:evidence-card",
        allowed: true,
      });
    });
  }
  const phase: LessonPhase = {
    phase_id: `${architecture}-phase`,
    label: architectureLabels[architecture],
    architecture,
    rounds: 2,
    speaking_policy: architecture === "pipeline" ? "ordered" : architecture === "supervisor" ? "coordinator" : "round_robin",
    coordinator_id: architecture === "supervisor" ? teacherId : undefined,
    peer_communication: false,
    pipeline_order: architecture === "pipeline" ? order : [],
    artifact_name: architecture === "pipeline" ? "evidence-card" : undefined,
    routes,
    blackboard: architecture === "blackboard" ? {
      readers: order,
      writers: order,
      teacher_review_required: true,
    } : undefined,
  };
  return {
    config_id: `${manifest.run_id}-${architecture}`,
    label: architectureLabels[architecture],
    status: "preset",
    agents,
    lesson_content: birdLesson.lesson_content,
    resources: [...birdLesson.resources],
    shared_artifacts: architecture === "pipeline" ? ["evidence-card"] : architecture === "blackboard" ? ["class-board"] : [],
    phases: [phase],
    budget: {max_turns: 24, max_messages: 40},
    assessment: {
      blueprint_id: birdLesson.assessment.assessment_id,
      fixed_items: true,
      independent: true,
      assistance_disabled: true,
    },
  };
}

export function displayName(configuration: ExperimentConfiguration, agentId: string): string {
  return configuration.agents.find((agent) => agent.agent_id === agentId)?.display_name ?? agentId;
}

export function markCustom(configuration: ExperimentConfiguration): ExperimentConfiguration {
  return {...configuration, status: "custom"};
}
