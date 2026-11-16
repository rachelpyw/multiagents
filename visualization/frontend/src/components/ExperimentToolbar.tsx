import {ArchitectureKind, ExperimentConfiguration} from "../experiment";

interface Props {
  configuration: ExperimentConfiguration;
  onPreset: (architecture: ArchitectureKind) => void;
  busy?: boolean;
}

const modes: {id: ArchitectureKind; label: string}[] = [
  {id: "supervisor", label: "Teacher-led · Supervisor"},
  {id: "pipeline", label: "Sequential · Relay"},
  {id: "decentralized", label: "Peer network"},
  {id: "blackboard", label: "Shared blackboard"},
];

export function ExperimentToolbar({configuration, onPreset, busy}: Props) {
  return <header className="experiment-toolbar">
    <label className="mode-select">Mode
      <select aria-label="Mode" value={configuration.phases[0]?.architecture} disabled={busy}
        onChange={(event) => {
          const mode = modes.find((mode) => mode.id === event.target.value);
          if (mode) onPreset(mode.id);
        }}>
        {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
      </select>
    </label>
  </header>;
}
