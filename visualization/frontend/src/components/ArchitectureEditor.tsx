import {useEffect, useState} from "react";
import {NormalizedEvent} from "../types";
import {
  ArchitectureKind,
  DirectedRoute,
  ExperimentConfiguration,
  LessonPhase,
  architectureDescriptions,
  displayName,
  markCustom,
} from "../experiment";

interface Props {
  configuration: ExperimentConfiguration;
  phaseIndex: number;
  events: NormalizedEvent[];
  selectedAgent: string;
  onSelectedAgent: (agentId: string) => void;
  onConfiguration: (configuration: ExperimentConfiguration) => void;
  onPhaseIndex: (index: number) => void;
}

const nodePositions = [
  {x: 260, y: 85}, {x: 90, y: 210}, {x: 220, y: 270}, {x: 390, y: 250},
  {x: 510, y: 150}, {x: 405, y: 70}, {x: 95, y: 80},
];

function updatePhase(
  configuration: ExperimentConfiguration,
  phaseIndex: number,
  update: (phase: LessonPhase) => LessonPhase,
) {
  return markCustom({
    ...configuration,
    phases: configuration.phases.map((phase, index) => index === phaseIndex ? update(phase) : phase),
  });
}

export function ArchitectureEditor(props: Props) {
  const [advancedJson, setAdvancedJson] = useState(JSON.stringify(props.configuration, null, 2));
  const [advancedError, setAdvancedError] = useState("");
  const phase = props.configuration.phases[props.phaseIndex];
  const selected = props.configuration.agents.find((agent) => agent.agent_id === props.selectedAgent);
  const recentInteractions = props.events.filter((event) => event.event_kind === "interaction").slice(-4);
  const activePairs = new Set(recentInteractions.flatMap((event) =>
    (event.payload.recipient_ids ?? []).map((targetId: string) => `${event.payload.speaker_id}->${targetId}`),
  ));
  useEffect(() => setAdvancedJson(JSON.stringify(props.configuration, null, 2)), [props.configuration]);

  const toggleRoute = (targetId: string) => {
    if (!selected || selected.agent_id === targetId) return;
    const existing = phase.routes.find(
      (route) => route.source_id === selected.agent_id && route.target_id === targetId && route.channel === "class",
    );
    const routes = existing
      ? phase.routes.filter((route) => route !== existing)
      : [...phase.routes, {source_id: selected.agent_id, target_id: targetId, channel: "class", allowed: true}];
    props.onConfiguration(updatePhase(props.configuration, props.phaseIndex, (current) => ({...current, routes})));
  };

  const changeArchitecture = (architecture: ArchitectureKind) => {
    props.onConfiguration(updatePhase(props.configuration, props.phaseIndex, (current) => ({
      ...current,
      architecture,
      coordinator_id: architecture === "supervisor" ? current.coordinator_id ?? props.configuration.agents[0]?.agent_id : undefined,
      pipeline_order: architecture === "pipeline" && current.pipeline_order.length < 2
        ? props.configuration.agents.map((agent) => agent.agent_id)
        : current.pipeline_order,
      artifact_name: architecture === "pipeline" ? current.artifact_name ?? "evidence-card" : undefined,
      blackboard: architecture === "blackboard" ? current.blackboard ?? {
        readers: props.configuration.agents.map((agent) => agent.agent_id),
        writers: props.configuration.agents.map((agent) => agent.agent_id),
        teacher_review_required: true,
      } : undefined,
    })));
  };

  const addAgent = () => {
    const suffix = props.configuration.agents.length + 1;
    props.onConfiguration(markCustom({
      ...props.configuration,
      agents: [...props.configuration.agents, {
        agent_id: `DraftAgent${suffix}`,
        display_name: `Draft agent ${suffix}`,
        role: "student",
        objective: "",
        allowed_actions: ["explain", "question", "request_help"],
        observable_resources: ["lesson_content"],
      }],
    }));
  };

  const duplicateAgent = () => {
    if (!selected) return;
    const agentId = `${selected.agent_id}-copy-${props.configuration.agents.length + 1}`;
    props.onConfiguration(markCustom({
      ...props.configuration,
      agents: [...props.configuration.agents, {...selected, agent_id: agentId, display_name: `${selected.display_name} copy`}],
    }));
    props.onSelectedAgent(agentId);
  };

  const removeAgent = () => {
    if (!selected || props.configuration.agents.length <= 2) return;
    props.onConfiguration(markCustom({
      ...props.configuration,
      agents: props.configuration.agents.filter((agent) => agent.agent_id !== selected.agent_id),
      phases: props.configuration.phases.map((item) => ({
        ...item,
        routes: item.routes.filter((route) => route.source_id !== selected.agent_id && route.target_id !== selected.agent_id),
        pipeline_order: item.pipeline_order.filter((agentId) => agentId !== selected.agent_id),
        blackboard: item.blackboard && {
          ...item.blackboard,
          readers: item.blackboard.readers.filter((agentId) => agentId !== selected.agent_id),
          writers: item.blackboard.writers.filter((agentId) => agentId !== selected.agent_id),
        },
      })),
    }));
    props.onSelectedAgent(props.configuration.agents.find((agent) => agent.agent_id !== selected.agent_id)!.agent_id);
  };

  const applyAdvancedJson = async () => {
    setAdvancedError("");
    try {
      const parsed = JSON.parse(advancedJson);
      const response = await fetch("/api/experiment-config/validate", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(parsed),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail?.[0]?.msg ?? "Configuration validation failed");
      }
      props.onConfiguration(markCustom(await response.json()));
    } catch (error) {
      setAdvancedError(String(error));
    }
  };

  const toggleBlackboardWriter = (allowed: boolean) => {
    if (!selected) return;
    props.onConfiguration(updatePhase(props.configuration, props.phaseIndex, (current) => ({
      ...current,
      blackboard: current.blackboard && {
        ...current.blackboard,
        writers: allowed
          ? [...new Set([...current.blackboard.writers, selected.agent_id])]
          : current.blackboard.writers.filter((agentId) => agentId !== selected.agent_id),
      },
    })));
  };

  const toggleBlackboardReader = (allowed: boolean) => {
    if (!selected) return;
    props.onConfiguration(updatePhase(props.configuration, props.phaseIndex, (current) => ({
      ...current,
      blackboard: current.blackboard && {
        ...current.blackboard,
        readers: allowed
          ? [...new Set([...current.blackboard.readers, selected.agent_id])]
          : current.blackboard.readers.filter((agentId) => agentId !== selected.agent_id),
      },
    })));
  };

  const movePipelineAgent = (agentId: string, offset: number) => {
    const currentIndex = phase.pipeline_order.indexOf(agentId);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= phase.pipeline_order.length) return;
    const pipelineOrder = [...phase.pipeline_order];
    [pipelineOrder[currentIndex], pipelineOrder[targetIndex]] = [pipelineOrder[targetIndex], pipelineOrder[currentIndex]];
    const routes: DirectedRoute[] = pipelineOrder.slice(0, -1).map((sourceId, index) => ({
      source_id: sourceId,
      target_id: pipelineOrder[index + 1],
      channel: `artifact:${phase.artifact_name}`,
      allowed: true,
    }));
    props.onConfiguration(updatePhase(props.configuration, props.phaseIndex, (current) => ({
      ...current,
      pipeline_order: pipelineOrder,
      routes,
    })));
  };

  const updateRounds = (rounds: number) => {
    props.onConfiguration(updatePhase(
      props.configuration,
      props.phaseIndex,
      (current) => ({...current, rounds}),
    ));
  };

  const updateBudget = (field: "max_turns" | "max_messages", value: number | undefined) => {
    props.onConfiguration(markCustom({
      ...props.configuration,
      budget: {...props.configuration.budget, [field]: value},
    }));
  };

  return (
    <section className="architecture-editor" aria-label="Editable architecture graph">
      <div className="architecture-canvas">
        <header>
          <div>
            <span>EDITABLE COMMUNICATION GRAPH</span>
            <h2>{phase.label}</h2>
            <p>{architectureDescriptions[phase.architecture]}</p>
          </div>
          <label>Lesson phase
            <select value={props.phaseIndex} onChange={(event) => props.onPhaseIndex(Number(event.target.value))}>
              {props.configuration.phases.map((item, index) => <option key={item.phase_id} value={index}>{item.label}</option>)}
            </select>
          </label>
        </header>
        <svg viewBox="0 0 600 340" role="img" aria-label="Agent communication graph">
          <defs>
            <marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
              <path d="M0 0L0 6L7 3Z" fill="currentColor" />
            </marker>
          </defs>
          {phase.routes.filter((route) => route.allowed).map((route, index) => {
            const sourceIndex = props.configuration.agents.findIndex((agent) => agent.agent_id === route.source_id);
            const targetIndex = props.configuration.agents.findIndex((agent) => agent.agent_id === route.target_id);
            const source = nodePositions[sourceIndex % nodePositions.length];
            const target = nodePositions[targetIndex % nodePositions.length];
            const active = activePairs.has(`${route.source_id}->${route.target_id}`);
            return <line key={`${route.source_id}-${route.target_id}-${index}`} className={active ? "actual-route" : "allowed-route"} x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd="url(#graph-arrow)" />;
          })}
          {props.configuration.agents.map((agent, index) => {
            const position = nodePositions[index % nodePositions.length];
            return (
              <g
                key={agent.agent_id}
                className={`architecture-node ${props.selectedAgent === agent.agent_id ? "selected" : ""}`}
                transform={`translate(${position.x} ${position.y})`}
                role="button"
                tabIndex={0}
                aria-label={`Edit ${agent.display_name}`}
                onClick={() => props.onSelectedAgent(agent.agent_id)}
                onKeyDown={(event) => event.key === "Enter" && props.onSelectedAgent(agent.agent_id)}
              >
                <circle r="34" />
                <text y="-3" textAnchor="middle">{agent.display_name.slice(0, 2).toUpperCase()}</text>
                <text y="50" textAnchor="middle" className="node-name">{agent.display_name}</text>
                <text y="63" textAnchor="middle" className="node-role">{agent.role}</text>
              </g>
            );
          })}
        </svg>
        <div className="graph-legend"><span className="allowed">Allowed route</span><span className="actual">Recorded message</span><span>Seating is configured separately in Room</span></div>
      </div>

      <aside className="architecture-properties">
        <label>Architecture
          <select value={phase.architecture} onChange={(event) => changeArchitecture(event.target.value as ArchitectureKind)}>
            <option value="supervisor">Supervisor</option>
            <option value="pipeline">Pipeline</option>
            <option value="decentralized">Decentralized</option>
            <option value="blackboard">Blackboard</option>
          </select>
        </label>
        {phase.architecture === "supervisor" && <label>Coordinator
          <select value={phase.coordinator_id} onChange={(event) => props.onConfiguration(updatePhase(props.configuration, props.phaseIndex, (current) => ({...current, coordinator_id: event.target.value})))}>
            {props.configuration.agents.map((agent) => <option key={agent.agent_id} value={agent.agent_id}>{agent.display_name}</option>)}
          </select>
        </label>}
        <label>Speaking policy
          <select value={phase.speaking_policy} onChange={(event) => props.onConfiguration(updatePhase(props.configuration, props.phaseIndex, (current) => ({...current, speaking_policy: event.target.value as LessonPhase["speaking_policy"]})))}>
            <option value="coordinator">Coordinator controlled</option>
            <option value="ordered">Ordered</option>
            <option value="round_robin">Round robin</option>
            <option value="open">Open</option>
          </select>
        </label>
        {phase.architecture === "pipeline" && <fieldset className="pipeline-order">
          <legend>Artifact order · {phase.artifact_name}</legend>
          {phase.pipeline_order.map((agentId, index) => <div key={agentId}>
            <span>{index + 1}. {displayName(props.configuration, agentId)}</span>
            <button disabled={index === 0} onClick={() => movePipelineAgent(agentId, -1)}>↑</button>
            <button disabled={index === phase.pipeline_order.length - 1} onClick={() => movePipelineAgent(agentId, 1)}>↓</button>
          </div>)}
        </fieldset>}
        {selected && <>
          <h3>{selected.display_name}</h3>
          <div className="agent-actions">
            <button onClick={addAgent}>Add</button>
            <button onClick={duplicateAgent}>Duplicate</button>
            <button onClick={removeAgent} disabled={props.configuration.agents.length <= 2}>Remove</button>
          </div>
          <label>Role
            <input value={selected.role} onChange={(event) => props.onConfiguration(markCustom({
              ...props.configuration,
              agents: props.configuration.agents.map((agent) => agent.agent_id === selected.agent_id ? {...agent, role: event.target.value} : agent),
            }))} />
          </label>
          <label>Objective
            <textarea value={selected.objective} onChange={(event) => props.onConfiguration(markCustom({
              ...props.configuration,
              agents: props.configuration.agents.map((agent) => agent.agent_id === selected.agent_id ? {...agent, objective: event.target.value} : agent),
            }))} />
          </label>
          <fieldset>
            <legend>Directed class routes from {selected.display_name}</legend>
            {props.configuration.agents.filter((agent) => agent.agent_id !== selected.agent_id).map((agent) => {
              const checked = phase.routes.some((route) =>
                route.source_id === selected.agent_id && route.target_id === agent.agent_id && route.allowed,
              );
              return <label className="route-toggle" key={agent.agent_id}><input type="checkbox" checked={checked} onChange={() => toggleRoute(agent.agent_id)} />{displayName(props.configuration, agent.agent_id)}</label>;
            })}
          </fieldset>
          {phase.architecture === "blackboard" && <fieldset>
            <legend>Blackboard permissions</legend>
            <label className="route-toggle"><input type="checkbox" checked={phase.blackboard?.readers.includes(selected.agent_id) ?? false} onChange={(event) => toggleBlackboardReader(event.target.checked)} />Read</label>
            <label className="route-toggle"><input type="checkbox" checked={phase.blackboard?.writers.includes(selected.agent_id) ?? false} onChange={(event) => toggleBlackboardWriter(event.target.checked)} />Write</label>
          </fieldset>}
        </>}
        <details className="configuration-section">
          <summary>Environment and scheduling</summary>
          <label>Lesson content
            <textarea value={props.configuration.lesson_content} onChange={(event) => props.onConfiguration(markCustom({...props.configuration, lesson_content: event.target.value}))} />
          </label>
          <label>Rounds
            <input type="number" min="1" value={phase.rounds} onChange={(event) => updateRounds(Number(event.target.value))} />
          </label>
          <label>Maximum turns
            <input type="number" min="1" value={props.configuration.budget.max_turns ?? ""} onChange={(event) => updateBudget("max_turns", Number(event.target.value) || undefined)} />
          </label>
          <label>Maximum messages
            <input type="number" min="1" value={props.configuration.budget.max_messages ?? ""} onChange={(event) => updateBudget("max_messages", Number(event.target.value) || undefined)} />
          </label>
          <button onClick={() => {
            const copy = {...phase, phase_id: `${phase.phase_id}-copy-${props.configuration.phases.length + 1}`, label: `${phase.label} copy`};
            props.onConfiguration(markCustom({...props.configuration, phases: [...props.configuration.phases, copy]}));
            props.onPhaseIndex(props.configuration.phases.length);
          }}>Add lesson phase</button>
          <label>Teacher support
            <select disabled value="runtime-defined"><option value="runtime-defined">Runtime-defined by AgentSchool prompts</option></select>
          </label>
          <small>Direct answer / hint / questioning controls are not exposed because the current AgentSchool runtime does not provide a verified switch.</small>
          <label className="route-toggle"><input type="checkbox" checked={props.configuration.assessment.independent && props.configuration.assessment.assistance_disabled} readOnly />Independent assessment; assistance disabled</label>
        </details>
        <details className="configuration-section">
          <summary>Advanced validated JSON</summary>
          <textarea className="advanced-json" value={advancedJson} onChange={(event) => setAdvancedJson(event.target.value)} />
          {advancedError && <p className="configuration-error">{advancedError}</p>}
          <button onClick={applyAdvancedJson}>Validate and apply</button>
        </details>
      </aside>
    </section>
  );
}
