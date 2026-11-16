import {useEffect, useMemo, useRef, useState} from "react";
import {LessonPhase} from "../experiment";
import {classroomActivity, lessonPictures, recordedRecipients, studentMessageRoutes} from "../replay";
import {NormalizedEvent, RunManifest} from "../types";

const interactionStyles = {
  explanation: {stroke: "#62c5f4", dash: "", icon: "i"},
  question: {stroke: "#ff7da8", dash: "10 7", icon: "?"},
  help_request: {stroke: "#a99cff", dash: "4 7", icon: "!"},
  other: {stroke: "#d7e5e5", dash: "3 8", icon: "·"},
} as const;

const positions = [
  {x: 492, y: 552},
  {x: 677, y: 452},
  {x: 865, y: 350},
  {x: 1050, y: 452},
  {x: 865, y: 552},
  {x: 677, y: 655},
];
const seats = [
  {x: 442, y: 480}, {x: 625, y: 378}, {x: 807, y: 278},
  {x: 1020, y: 378}, {x: 832, y: 480}, {x: 645, y: 582},
];
const teacherPosition = {x: 280, y: 275};

// A 2:1 floor grid through the aisles, excluding the fixed furniture.
const movementTiles = Array.from({length: 17}, (_, row) =>
  Array.from({length: 17}, (_, column) => ({
    x: 680 + (column - row) * 36,
    y: 214 + (column + row) * 18,
  })),
).flat().filter((tile) =>
  tile.y > 270 && tile.y < 695 && tile.x > 165 && tile.x < 1220
  && !(tile.x < 490 && tile.y < 420)
  && !seats.some((seat) => ((tile.x - (seat.x - 55)) / 86) ** 2 + ((tile.y - (seat.y + 7)) / 48) ** 2 < 1),
);

type IsoDirection = "ne" | "nw" | "se" | "sw";

function directionBetween(from: {x: number; y: number}, to: {x: number; y: number}): IsoDirection {
  const horizontal = to.x >= from.x ? "e" : "w";
  const vertical = to.y >= from.y ? "s" : "n";
  return `${vertical}${horizontal}` as IsoDirection;
}

const tileNeighbors = movementTiles.map((tile, index) =>
  movementTiles
    .map((candidate, candidateIndex) => ({
      index: candidateIndex,
      distance: Math.hypot(candidate.x - tile.x, candidate.y - tile.y),
    }))
    .filter((candidate) => candidate.index !== index && candidate.distance < 42)
    .map((candidate) => candidate.index),
);

function closestTile(position: {x: number; y: number}) {
  return movementTiles.reduce((closest, tile, index) => {
    const distance = Math.hypot(position.x - tile.x, position.y - tile.y);
    return distance < closest.distance ? {index, distance} : closest;
  }, {index: 0, distance: Number.POSITIVE_INFINITY}).index;
}

function tilePath(start: number, destination: number, blocked: Set<number>) {
  const queue = [[start]];
  const visited = new Set([start]);
  while (queue.length) {
    const path = queue.shift()!;
    const current = path.at(-1)!;
    if (current === destination) return path;
    for (const neighbor of tileNeighbors[current]) {
      if (!visited.has(neighbor) && !blocked.has(neighbor)) {
        visited.add(neighbor);
        queue.push([...path, neighbor]);
      }
    }
  }
  return [];
}

interface Props {
  manifest: RunManifest;
  interactions: NormalizedEvent[];
  activity: ReturnType<typeof classroomActivity>;
  activePhase: LessonPhase;
  selectedStudent: string;
  selectedEvent?: string;
  conversationNotice: string;
  conversationReady: boolean;
  steeringState?: "pending" | "complete";
  onStartTest: () => void;
  canStartTest: boolean;
  testStarting: boolean;
  testCompleted: number;
  onNextClass: () => void;
  canNextClass: boolean;
  classStarting: boolean;
  followingLive: boolean;
  onTalk: (targetId?: string) => void;
  onFollowLive: () => void;
  onStudent: (id: string) => void;
  onEvent: (event: NormalizedEvent) => void;
}

function PixelCharacter({
  color,
  selected,
  variant,
  direction = "se",
}: {
  color: string;
  selected: boolean;
  variant: number;
  direction?: IsoDirection;
}) {
  const facingAway = direction === "ne" || direction === "nw";
  return (
    <g className={`pixel-character direction-${direction} variant-${variant} ${selected ? "selected" : ""}`}>
      <g className="sprite-facing" transform="scale(1.25)">
      <rect x="-25" y="29" width="50" height="7" fill="rgba(45,35,27,.28)" />
      <rect className="sprite-leg left" x="-19" y="8" width="14" height="24" fill="#31485d" />
      <rect className="sprite-leg right" x="5" y="8" width="14" height="24" fill="#31485d" />
      <rect x="-21" y="28" width="18" height="7" fill="#202d39" />
      <rect x="3" y="28" width="18" height="7" fill="#202d39" />
      <rect className="sprite-arm left" x="-29" y="-14" width="9" height="26" fill={color} />
      <rect className="sprite-arm right" x="20" y="-14" width="9" height="26" fill={color} />
      <rect x="-29" y="9" width="9" height="8" fill="#dfa277" />
      <rect x="20" y="9" width="9" height="8" fill="#dfa277" />
      <rect x="-21" y="-18" width="42" height="33" fill={color} stroke="#3e322e" strokeWidth="4" />
      <rect x="-17" y="-13" width="4" height="23" fill="rgba(255,255,255,.18)" />
      {variant % 3 === 0 && <>
        <path d="M-9 -16L0 -7L9 -16" fill="none" stroke="#f0e0bd" strokeWidth="4" />
        <rect x="8" y="-2" width="8" height="8" fill="#d9b55c" stroke="#4b382f" strokeWidth="2" />
      </>}
      {variant % 3 === 1 && <>
        <rect x="-19" y="-2" width="38" height="7" fill="#d8ad55" opacity=".85" />
        <rect x="-2" y="-15" width="4" height="25" fill="#f4e4c1" opacity=".75" />
      </>}
      {variant % 3 === 2 && <>
        <rect x="-15" y="-9" width="30" height="5" fill="#d98976" opacity=".8" />
        <rect x="-2" y="-2" width="4" height="4" fill="#f3deb5" />
        <rect x="-2" y="6" width="4" height="4" fill="#f3deb5" />
      </>}
      <rect x="-5" y="-24" width="10" height="8" fill="#dfa277" />
      <rect x="-21" y="-51" width="42" height="31" fill="#e6ad82" stroke="#3e322e" strokeWidth="4" />
      <rect x="-23" y="-42" width="5" height="12" fill="#dfa277" />
      <rect x="18" y="-42" width="5" height="12" fill="#dfa277" />
      {variant % 3 === 0 && <>
        <rect x="-20" y="-54" width="40" height="10" fill="#47352f" />
        <rect x="-20" y="-48" width="9" height="13" fill="#47352f" />
        <rect x="12" y="-48" width="8" height="8" fill="#47352f" />
      </>}
      {variant % 3 === 1 && <>
        <rect x="-18" y="-56" width="36" height="11" fill="#2e2928" />
        <rect x="-23" y="-50" width="9" height="17" fill="#2e2928" />
        <rect x="14" y="-49" width="9" height="17" fill="#2e2928" />
        <rect x="-8" y="-61" width="18" height="8" fill="#2e2928" />
      </>}
      {variant % 3 === 2 && <>
        <rect x="-20" y="-54" width="40" height="9" fill="#7e4938" />
        <rect x="-20" y="-49" width="8" height="19" fill="#7e4938" />
        <rect x="12" y="-49" width="8" height="19" fill="#7e4938" />
        <rect x="-25" y="-45" width="8" height="8" fill="#7e4938" />
      </>}
      {!facingAway && <>
        <rect x="-12" y="-38" width="5" height="5" fill="#263238" />
        <rect x="8" y="-38" width="5" height="5" fill="#263238" />
        <rect x="-15" y="-43" width="8" height="2" fill="#6f4638" />
        <rect x="8" y="-43" width="8" height="2" fill="#6f4638" />
        <rect x="-3" y="-28" width="8" height="3" fill="#a65d4b" />
      </>}
      {facingAway && <rect x="-16" y="-48" width="32" height="19" fill={variant % 3 === 0 ? "#47352f" : variant % 3 === 1 ? "#2e2928" : "#7e4938"} />}
      </g>
    </g>
  );
}

function TalkingBubble({kind, preparing = false}: {kind: string; preparing?: boolean}) {
  const symbol = kind === "question" ? "?" : kind === "help_request" ? "!" : undefined;
  return <g className={`talking-bubble ${preparing ? "preparing" : ""}`} transform="translate(52 -64)" role="img"
    aria-label={kind === "writing" ? preparing ? "Preparing test" : "Writing test" : symbol === "?" ? "Asking a question" : symbol === "!" ? "Asking for help" : "Speaking"}>
    <path d="M-28-20H28Q34-20 34-14V14Q34 20 28 20H-13L-27 31V20H-28Q-34 20-34 14V-14Q-34-20-28-20Z" />
    {kind === "writing" ? <g transform="translate(-12 -12) scale(1.2)">
      <g className="bubble-pencil">
        <path d="M4 13L13 4L17 8L8 17L3 18Z" fill="#bba44b" />
        <path d="M13 4L15 2L19 6L17 8Z" fill="#bd846f" />
        <path d="M3 18L4 13L8 17Z" fill="#35432c" />
      </g>
    </g> : symbol ? <text y="9" textAnchor="middle">{symbol}</text>
      : <g className="talking-dots"><circle cx="-15" r="4" /><circle r="4" /><circle cx="15" r="4" /></g>}
  </g>;
}

export function ClassroomView({
  manifest,
  interactions,
  activity,
  activePhase,
  selectedStudent,
  selectedEvent,
  conversationNotice,
  conversationReady,
  steeringState,
  onStartTest,
  canStartTest,
  testStarting,
  testCompleted,
  onNextClass,
  canNextClass,
  classStarting,
  followingLive,
  onTalk,
  onFollowLive,
  onStudent,
  onEvent,
}: Props) {
  const teacherId = String(manifest.teacher.name ?? "Teacher");
  const basePositions = useMemo(() => Object.fromEntries(
    manifest.roster.map((student, index) => [student.student_id, positions[index % positions.length]]),
  ), [manifest.roster]);
  const [manualPositions, setManualPositions] = useState<Record<string, {x: number; y: number}>>({});
  const [walkingStudents, setWalkingStudents] = useState<Set<string>>(new Set());
  const [studentDirections, setStudentDirections] = useState<Record<string, IsoDirection>>({});
  const [movementNotice, setMovementNotice] = useState("");
  const [hoveredStudent, setHoveredStudent] = useState<string>();
  const [focusedStudent, setFocusedStudent] = useState<string>();
  const walkTimers = useRef<Record<string, number>>({});
  const recent = activity.isTest ? [] : interactions.slice(-4);
  const routes = studentMessageRoutes(activity.isTest ? [] : interactions, manifest, selectedStudent).slice(-4);
  const latest = interactions.at(-1);
  const dialogue = interactions.find((event) => event.event_id === selectedEvent) ?? latest;
  const testFailed = manifest.run_configuration?.runner === "assessment"
    && manifest.run_configuration?.status === "failed" && followingLive;
  const speakingId = !activity.isTest && !activity.testComplete && !testFailed ? dialogue?.payload.speaker_id : undefined;
  const latestTeacherInteraction = !activity.isTest && latest?.payload.speaker_id === teacherId ? latest : undefined;
  const pictures = activity.isTest || activity.testComplete || testFailed ? [] : lessonPictures(interactions, manifest, dialogue);
  const boardColumns = Math.min(3, Math.max(1, pictures.length));
  const boardRows = Math.ceil(pictures.length / boardColumns);
  const permitsPeer = (target: string) => activePhase.architecture !== "pipeline" && (activePhase.architecture === "blackboard"
    ? [selectedStudent, target].every((id) => activePhase.blackboard?.writers.includes(id) && activePhase.blackboard?.readers.includes(id))
    : activePhase.routes.some((route) =>
    route.allowed && route.source_id === selectedStudent && route.target_id === target && route.channel === "class")
    && activePhase.routes.some((route) =>
      route.allowed && route.source_id === target && route.target_id === selectedStudent && route.channel === "class")
    && (activePhase.architecture !== "supervisor" || activePhase.peer_communication));
  const permittedPeers = manifest.roster.filter((student) => student.student_id !== selectedStudent && permitsPeer(student.student_id));
  const steeringEnabled = manifest.mode === "live" && !activity.isTest && !activity.testComplete && !testFailed
    && conversationReady && permittedPeers.length > 0;
  const eligibleAgents = new Set(steeringEnabled ? permittedPeers.map((student) => student.student_id) : []);
  const resolveAgent = (agentId: string) =>
    manifest.roster.find((student) => student.student_id === agentId)?.display_name
    ?? (agentId === teacherId ? teacherId : agentId);
  const formatTime = (time?: string) => time
    ? new Date(time).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})
    : "Not recorded";
  useEffect(() => {
    setManualPositions({});
    setStudentDirections({});
    setMovementNotice("");
    return () => Object.values(walkTimers.current).forEach(window.clearTimeout);
  }, [manifest.run_id]);

  useEffect(() => {
    if (!activity.isTest) return;
    Object.values(walkTimers.current).forEach(window.clearTimeout);
    setWalkingStudents(new Set());
  }, [activity.isTest]);

  const studentPositions = Object.fromEntries(
    manifest.roster.map((student, index) => [
      student.student_id,
      activity.isTest
        ? seats[index % seats.length]
        : manualPositions[student.student_id] ?? basePositions[student.student_id],
    ]),
  );
  const proximityActive = new Set<string>();
  manifest.roster.forEach((student, index) => {
    const position = studentPositions[student.student_id];
    manifest.roster.slice(index + 1).forEach((other) => {
      const otherPosition = studentPositions[other.student_id];
      const overlap = ((position.x - otherPosition.x) / 96) ** 2
        + ((position.y - otherPosition.y) / 40) ** 2 <= 1;
      if (overlap && (student.student_id === selectedStudent && eligibleAgents.has(other.student_id)
        || other.student_id === selectedStudent && eligibleAgents.has(student.student_id))) {
        proximityActive.add(student.student_id);
        proximityActive.add(other.student_id);
      }
    });
  });
  const targetId = manifest.roster
    .filter((student) => eligibleAgents.has(student.student_id))
    .map((student) => {
      const source = studentPositions[selectedStudent];
      const target = studentPositions[student.student_id];
      return {
        id: student.student_id,
        distance: source ? ((source.x - target.x) / 96) ** 2 + ((source.y - target.y) / 40) ** 2 : Infinity,
      };
    })
    .filter((candidate) => candidate.distance <= 1)
    .sort((left, right) => left.distance - right.distance)[0]?.id;
  const canTalk = steeringEnabled && steeringState !== "pending" && Boolean(targetId);
  const taskLabels: Record<string, string> = {
    ask_question: "Teacher question", feedback: "Student report", lecture: "Teacher explanation",
    pipeline_handoff: "Passing evidence card", group_discussion: "Peer discussion",
    blackboard_write: "Board contribution", blackboard_review: "Teacher review",
  };
  const taskLabel = activity.isTest || activity.testComplete || testFailed ? activity.task
    : taskLabels[dialogue?.payload.active_event ?? ""] ?? "Class discussion";

  useEffect(() => {
    if (!steeringEnabled) return;
    const talk = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      if (canTalk) onTalk(targetId);
    };
    window.addEventListener("keydown", talk);
    return () => window.removeEventListener("keydown", talk);
  }, [steeringEnabled, canTalk, targetId, onTalk]);
  const moveSelected = (position: {x: number; y: number}) => {
    if (!selectedStudent || activity.isTest) return;
    window.clearTimeout(walkTimers.current[selectedStudent]);
    const start = closestTile(studentPositions[selectedStudent]);
    const destination = closestTile(position);
    const blocked = new Set(
      movementTiles.flatMap((tile, index) =>
        Object.entries(studentPositions).some(([studentId, studentPosition]) =>
          studentId !== selectedStudent
          && Math.hypot(studentPosition.x - tile.x, studentPosition.y - tile.y) < 58,
        ) ? [index] : [],
      ),
    );
    if (blocked.has(destination)) {
      setMovementNotice("That tile is occupied. Choose a clear aisle tile.");
      return;
    }
    const path = tilePath(start, destination, blocked).slice(1);
    if (!path.length) {
      if (start !== destination) setMovementNotice("No clear path to that tile. Choose another aisle.");
      return;
    }
    setMovementNotice("");

    setWalkingStudents((current) => new Set(current).add(selectedStudent));
    const walkStep = (step: number) => {
      const previous = step === 0 ? studentPositions[selectedStudent] : movementTiles[path[step - 1]];
      setStudentDirections((current) => ({
        ...current,
        [selectedStudent]: directionBetween(previous, movementTiles[path[step]]),
      }));
      setManualPositions((current) => ({
        ...current,
        [selectedStudent]: movementTiles[path[step]],
      }));
      if (step < path.length - 1) {
        walkTimers.current[selectedStudent] = window.setTimeout(() => walkStep(step + 1), 240);
      } else {
        walkTimers.current[selectedStudent] = window.setTimeout(() => {
          setWalkingStudents((current) => {
            const next = new Set(current);
            next.delete(selectedStudent);
            return next;
          });
        }, 240);
      }
    };
    walkStep(0);
  };

  useEffect(() => {
    const moveWithKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      const directionKeys: Record<string, "north" | "south" | "east" | "west"> = {
        w: "north",
        arrowup: "north",
        s: "south",
        arrowdown: "south",
        d: "east",
        arrowright: "east",
        a: "west",
        arrowleft: "west",
      };
      const desired = directionKeys[key];
      if (!desired || !selectedStudent) return;
      const currentTile = closestTile(studentPositions[selectedStudent]);
      const candidates = tileNeighbors[currentTile].map((index) => ({index, tile: movementTiles[index]}));
      const current = movementTiles[currentTile];
      const eligible = candidates.filter(({tile}) => (
        desired === "north" ? tile.y < current.y
          : desired === "south" ? tile.y > current.y
            : desired === "east" ? tile.x > current.x
              : tile.x < current.x
      ));
      const next = eligible.sort((left, right) => (
        desired === "north" ? left.tile.y - right.tile.y
          : desired === "south" ? right.tile.y - left.tile.y
            : desired === "east" ? right.tile.x - left.tile.x
              : left.tile.x - right.tile.x
      ))[0];
      if (!next) return;
      event.preventDefault();
      moveSelected(next.tile);
    };
    window.addEventListener("keydown", moveWithKeyboard);
    return () => window.removeEventListener("keydown", moveWithKeyboard);
  }, [selectedStudent, studentPositions]);

  return (
    <section className="pixel-room" aria-label="AgentSchool pixel classroom">
      <svg viewBox="0 0 1366 768" shapeRendering="crispEdges" role="img" aria-label="Isometric classroom with selectable students">
        <defs>
          <clipPath id="teacher-desk-front"><path d="M224 311L300 351L473 264L473 345L300 434L224 394Z" /></clipPath>
          {Object.entries(interactionStyles).map(([key, style]) => (
            <marker key={key} id={`pixel-arrow-${key}`} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill={style.stroke} />
            </marker>
          ))}
        </defs>
        <image href="/classroom-background.jpeg" width="1366" height="768" aria-label="Furnished pixel classroom" />
        {pictures.length > 0 && <g className="lesson-board" transform="matrix(1 -.5 0 1 0 0)"
          role="group" aria-label="Lesson bird illustrations">
          <rect x="88" y="194" width="278" height="132" rx="3" fill="#304e3f" />
          {pictures.map((picture, index) => {
            const width = 266 / boardColumns;
            const height = 120 / boardRows;
            const x = 94 + (index % boardColumns) * width;
            const y = 200 + Math.floor(index / boardColumns) * height;
            return <g key={picture.image_url}>
              <image href={picture.image_url} x={x + 3} y={y} width={width - 6} height={height - 17}
                role="img" aria-label={picture.image_alt} preserveAspectRatio="xMidYMid meet" />
              <text x={x + width / 2} y={y + height - 4} textAnchor="middle">{picture.label}</text>
            </g>;
          })}
        </g>}

        <g className={`movement-grid ${selectedStudent ? "active" : ""}`} aria-label="Walkable floor tiles">
          {movementTiles.map((tile, index) => (
            <g
              key={index}
              className="movement-tile"
              role="button"
              tabIndex={activity.isTest ? -1 : 0}
              aria-disabled={activity.isTest}
              aria-label={`Move selected student to floor tile ${index + 1}`}
              data-floor-x={tile.x}
              data-floor-y={tile.y}
              onClick={() => moveSelected(tile)}
              onKeyDown={(event) => event.key === "Enter" && moveSelected(tile)}
            >
              <polygon points={`${tile.x},${tile.y - 20} ${tile.x + 38},${tile.y} ${tile.x},${tile.y + 20} ${tile.x - 38},${tile.y}`} />
            </g>
          ))}
        </g>

        <g
          className={`teacher-sprite ${speakingId === teacherId ? "speaking" : ""} ${eligibleAgents.has(teacherId) ? "talk-eligible" : ""} ${latestTeacherInteraction ? `action-${latestTeacherInteraction.payload.interaction_type === "question" ? "raise-hand" : latestTeacherInteraction.payload.interaction_type === "help_request" ? "request-help" : "explain"}` : "action-idle"}`}
          transform={`translate(${teacherPosition.x} ${teacherPosition.y})`}
          data-talk-eligible={eligibleAgents.has(teacherId) || undefined}
        >
          <PixelCharacter color="#774c9d" selected={false} variant={2} direction="se" />
          {eligibleAgents.has(teacherId) && <path className="route-eligible-marker" d="M31 37L38 44L31 51L24 44Z" />}
          {speakingId === teacherId && <TalkingBubble kind={dialogue?.payload.interaction_type ?? "other"} />}
        </g>
        <image href="/classroom-background.jpeg" width="1366" height="768" clipPath="url(#teacher-desk-front)" pointerEvents="none" />

        {routes.map(({event, targetId}) => {
          const payload = event.payload;
          const source = payload.speaker_id === teacherId ? teacherPosition : studentPositions[payload.speaker_id];
          const targetPosition = targetId === teacherId ? teacherPosition : studentPositions[targetId];
          const style = interactionStyles[payload.interaction_type as keyof typeof interactionStyles] ?? interactionStyles.other;
          if (!source || !targetPosition) return null;
          const target = {...targetPosition, id: targetId};
          return (
            <g
              key={`${event.event_id}-${target.id}`}
              className={`pixel-connection ${event.payload.observer_request_id ? "steered" : ""} ${selectedEvent === event.event_id ? "selected" : ""}`}
              onClick={() => onEvent(event)}
              onKeyDown={(key) => key.key === "Enter" && onEvent(event)}
              role="button"
              aria-label={`${resolveAgent(payload.speaker_id)} to ${resolveAgent(targetId)}: ${payload.interaction_type}`}
              tabIndex={0}
            >
              <title>{resolveAgent(payload.speaker_id)} → {resolveAgent(targetId)} · {formatTime(event.simulation_time)} · {payload.interaction_type}</title>
              <path
                d={`M${source.x} ${source.y - 48} Q${(source.x + target.x) / 2} ${Math.min(source.y, target.y) - 120} ${target.x} ${target.y - 50}`}
                fill="none"
                stroke={style.stroke}
                strokeWidth={selectedEvent === event.event_id ? 4 : 2.5}
                strokeDasharray={style.dash}
                markerEnd={`url(#pixel-arrow-${payload.interaction_type})`}
              />
              <circle cx={(source.x + target.x) / 2} cy={Math.min(source.y, target.y) - 84} r="10" fill="#fff8e8" stroke={style.stroke} strokeWidth="2" />
              <text x={(source.x + target.x) / 2} y={Math.min(source.y, target.y) - 80} textAnchor="middle" fill="#3e4650">{style.icon}</text>
            </g>
          );
        })}

        {[...manifest.roster].sort((a, b) => studentPositions[a.student_id].y - studentPositions[b.student_id].y).map((student) => {
          const position = studentPositions[student.student_id];
          const active = [...recent].reverse().find((event) => event.student_ids.includes(student.student_id));
          const isSpeaker = speakingId === student.student_id;
          const action = activity.isTest ? "test"
            : walkingStudents.has(student.student_id)
            ? "walk"
            : isSpeaker && active?.payload.active_event?.includes("blackboard")
              ? "contribute-board"
              : isSpeaker && active?.payload.active_event?.includes("pipeline")
                ? "handoff"
                : isSpeaker && /read|write/.test(active?.payload.active_event ?? "")
                  ? "read-write"
                  : isSpeaker && active?.payload.active_event?.includes("wait")
                    ? "wait-turn"
                : isSpeaker && active?.payload.interaction_type === "explanation"
                  ? "explain"
                  : isSpeaker && active?.payload.interaction_type === "question"
                    ? "raise-hand"
                    : isSpeaker && active?.payload.interaction_type === "help_request"
                      ? "request-help"
                      : active
                        ? "sit-listen"
                        : "idle";
          const badge = action === "explain" ? "●" : action === "raise-hand" ? "?" : action === "request-help" ? "!" : action === "handoff" ? "▤" : action === "contribute-board" || action === "read-write" ? "✎" : action === "wait-turn" ? "…" : "";
          const interactionPartnerId = isSpeaker
            ? active && recordedRecipients(active, manifest)[0]
            : active?.payload.speaker_id;
          const interactionPartnerPosition = interactionPartnerId === teacherId
            ? teacherPosition
            : interactionPartnerId
              ? studentPositions[interactionPartnerId]
              : undefined;
          const direction = activity.isTest ? "nw" : walkingStudents.has(student.student_id)
            ? studentDirections[student.student_id] ?? "se"
            : interactionPartnerPosition
              ? directionBetween(position, interactionPartnerPosition)
              : studentDirections[student.student_id] ?? "se";
          return (
            <g
              key={student.student_id}
              className={`student-sprite-button action-${action} ${activity.isTest && testStarting ? "preparing" : ""} ${isSpeaker ? "speaking" : ""} ${eligibleAgents.has(student.student_id) ? "talk-eligible" : ""} ${proximityActive.has(student.student_id) ? "proximity-active" : ""} ${walkingStudents.has(student.student_id) ? "walking" : ""}`}
              onClick={() => onStudent(student.student_id)}
              onKeyDown={(event) => event.key === "Enter" && onStudent(student.student_id)}
              onMouseEnter={() => setHoveredStudent(student.student_id)}
              onMouseLeave={() => setHoveredStudent(undefined)}
              onFocus={() => setFocusedStudent(student.student_id)}
              onBlur={() => setFocusedStudent(undefined)}
              tabIndex={0}
              role="button"
              aria-label={`Select ${student.display_name}`}
              data-direction={direction}
              data-action={action}
              data-desk-id={activity.isTest ? student.student_id : undefined}
              data-talk-eligible={eligibleAgents.has(student.student_id) || undefined}
              style={{transform: `translate(${position.x}px, ${position.y}px)`}}
            >
              {steeringEnabled && (student.student_id === selectedStudent || eligibleAgents.has(student.student_id)) &&
                <ellipse className="proximity-ring" cx="0" cy="31" rx="48" ry="20" style={{color: student.color}} />}
              {selectedStudent === student.student_id && <path className="selection-diamond" d="M0 45L18 35L0 25L-18 35Z" />}
              {eligibleAgents.has(student.student_id) && <path className="route-eligible-marker" d="M31 37L38 44L31 51L24 44Z" />}
              <rect
                x="-32"
                y="-66"
                width="64"
                height="118"
                fill="transparent"
                pointerEvents="all"
              />
              <PixelCharacter
                color={student.color}
                selected={selectedStudent === student.student_id}
                variant={manifest.roster.indexOf(student)}
                direction={direction}
              />
              {activity.isTest && <g className="test-paper" transform="translate(-9 -3)">
                <path d="M-10 0L12 -7L23 1L0 9Z" fill="#fffbed" stroke="#51483e" strokeWidth="2" />
                <path className="test-pencil" d="M3 0L16 -9" stroke="#b57f36" strokeWidth="3" />
              </g>}
              {activity.isTest ? <TalkingBubble kind="writing" preparing={testStarting} />
                : isSpeaker && <TalkingBubble kind={dialogue?.payload.interaction_type ?? "other"} />}
              {active && !activity.isTest && !isSpeaker && <g className="action-badge" transform="translate(31 -47)">
                <rect x="-9" y="-10" width="20" height="20" fill={interactionStyles[active.payload.interaction_type as keyof typeof interactionStyles]?.stroke ?? "#fff"} stroke="#17243b" strokeWidth="3" />
                <text x="1" y="5" textAnchor="middle">{badge}</text>
              </g>}
            </g>
          );
        })}
        {canTalk && <g className="talk-prompt" role="button" tabIndex={0}
          aria-label={`Talk to ${resolveAgent(targetId!)}`}
          transform={`translate(${studentPositions[selectedStudent].x} ${studentPositions[selectedStudent].y - 104})`}
          onClick={() => onTalk(targetId)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.code !== "Space") return;
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) onTalk(targetId);
          }}>
          <rect x="-82" y="-19" width="164" height="36" rx="6" />
          <path d="M-7 17L0 24L7 17" />
          <text y="4" textAnchor="middle">[space] to talk</text>
        </g>}
        <g className="nameplate-overlay" pointerEvents="none">
          <g className={speakingId === teacherId ? "speaking" : ""}
            transform={`translate(${teacherPosition.x} ${teacherPosition.y + 52})`}>
            <g className="sprite-nameplate teacher-nameplate">
              <rect x="-58" y="-13" width="116" height="24" rx="4" />
              <text x="0" y="4" textAnchor="middle" className="sprite-name">{teacherId}</text>
            </g>
          </g>
          {manifest.roster.map((student) => {
            const position = studentPositions[student.student_id];
            const visible = selectedStudent === student.student_id || hoveredStudent === student.student_id
              || focusedStudent === student.student_id;
            return <g key={student.student_id} data-nameplate-id={student.student_id}
              className={`nameplate-anchor ${visible ? "nameplate-visible" : ""} ${speakingId === student.student_id ? "speaking" : ""}`}
              style={{transform: `translate(${position.x}px, ${position.y + 52}px)`}}>
              <g className="sprite-nameplate">
                <rect x="-52" y="-13" width="104" height="24" rx="4" />
                <text x="0" y="4" textAnchor="middle" className="sprite-name">{student.display_name}</text>
              </g>
            </g>;
          })}
        </g>
      </svg>
      <section className="game-dialogue" aria-label="Classroom dialogue" aria-live="polite">
        <div className="classroom-taskline" aria-label="Class time and task">
          <time title="Recorded simulation time">{formatTime(activity.time)}</time><strong>{taskLabel}</strong>
          <div className="classroom-commands">
            {canNextClass ? <button className="next-class-button" onClick={onNextClass} disabled={classStarting}>
              {classStarting ? "Starting class…" : manifest.run_configuration?.runner === "native" ? "Resume live" : "Next class"}</button> : null}
            {canStartTest && <button className="start-test-button" onClick={onStartTest} disabled={testStarting}
              title="Run the same independent bird test for every student.">
              {testStarting ? "Preparing test…" : "Start test"}</button>}
          </div>
        </div>
        <header className="dialogue-speaker">
          <strong>{testFailed ? "Test failed" : activity.testComplete ? "Class complete" : activity.isTest ? "Independent assessment" : dialogue ? resolveAgent(dialogue.payload.speaker_id) : "Classroom"}</strong>
          {permittedPeers.length > 0 && steeringState && <span className="steering-status" role="status">
            Steering…{steeringState === "complete" && <svg viewBox="0 0 16 16" role="img" aria-label="Complete">
              <path d="M3 8l3 3 7-7" />
            </svg>}
          </span>}
          {manifest.mode === "live" && !followingLive && <button onClick={onFollowLive}>Follow live</button>}
          {(conversationNotice || movementNotice) && <span className="steering-feedback" role="status">{conversationNotice || movementNotice}</span>}
        </header>
        <p>{testFailed ? "Test stopped. Completed answers are in the sidebar."
          : activity.testComplete ? "Results saved. Ready for the next class." : activity.isTest ? testStarting ? "Students are taking their seats."
          : `${testCompleted}/${manifest.roster.length} student results received.`
          : dialogue?.payload.content ?? "Waiting for the lesson…"}</p>
      </section>
    </section>
  );
}
