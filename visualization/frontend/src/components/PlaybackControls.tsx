interface Props {
  playing: boolean;
  playhead: number;
  max: number;
  speed: number;
  onPlaying: (value: boolean) => void;
  onPlayhead: (value: number) => void;
  onSpeed: (value: number) => void;
}

export function PlaybackControls(props: Props) {
  return (
    <div className="replay-hud" aria-label="Replay controls">
      <button className="pixel-button primary" onClick={() => props.onPlaying(!props.playing)}>
        {props.playing ? "Ⅱ" : "▶"} <span>{props.playing ? "Pause" : "Play"}</span>
      </button>
      <button className="pixel-button" onClick={() => props.onPlayhead(Math.min(props.max, props.playhead + 1))} disabled={props.playhead >= props.max}>
        ▷ <span>Step</span>
      </button>
      <input
        aria-label="Replay playhead"
        type="range"
        min={0}
        max={Math.max(0, props.max)}
        value={Math.max(0, props.playhead)}
        onChange={(event) => props.onPlayhead(Number(event.target.value))}
      />
      <span className="event-counter">{props.max < 0 ? "0 / 0" : `${props.playhead + 1} / ${props.max + 1}`}</span>
      <select aria-label="Replay speed" value={props.speed} onChange={(event) => props.onSpeed(Number(event.target.value))}>
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
        <option value={4}>4×</option>
      </select>
    </div>
  );
}
