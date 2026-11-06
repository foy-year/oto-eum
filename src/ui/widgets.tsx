import { useEffect, useRef, useState, type ReactNode } from 'react';
import { waveformPeaks, toMono, type Pcm } from '../core/audio/pcm';
import { position, onPlayerChange } from './player';
import { midiToName, nameToMidi } from '../core/analysis/pitch';

export function Num(props: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; width?: number }) {
  const [text, setText] = useState(String(round(props.value)));
  useEffect(() => setText(String(round(props.value))), [props.value]);
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        style={{ width: props.width ?? 80 }}
        value={text}
        step={props.step ?? 0.01}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
      {props.unit && <em>{props.unit}</em>}
    </label>
  );
}

export function Slider(props: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; unit?: string }) {
  return (
    <label className="field slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(parseFloat(e.target.value))} />
      <code>
        {round(props.value)}
        {props.unit ?? ''}
      </code>
    </label>
  );
}

export function Pitch(props: { label: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(midiToName(props.value));
  useEffect(() => setText(midiToName(props.value)), [props.value]);
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        style={{ width: 56 }}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const m = nameToMidi(e.target.value) ?? (Number.isFinite(+e.target.value) ? +e.target.value : null);
          if (m != null) props.onChange(m);
        }}
      />
    </label>
  );
}

export function Check(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field check">
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

export function Pick<T extends string>(props: { label: string; value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; placeholder?: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.placeholder != null && <option value="">{props.placeholder}</option>}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="row">{children}</div>;
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h3>{title}</h3>
        <div className="actions">{actions}</div>
      </header>
      {children}
    </section>
  );
}

/**
 * Waveform with drag-to-select region, markers, and live playhead.
 * `offset` = absolute time of the first sample of `pcm` (for playhead mapping).
 */
export function Waveform(props: {
  pcm: Pcm | null;
  selection?: { start: number; end: number } | null;
  onSelect?: (sel: { start: number; end: number }) => void;
  markers?: number[];
  regions?: { start: number; end: number; label?: string; active?: boolean }[];
  height?: number;
  playheadOffset?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<number | null>(null);
  const [, force] = useState(0);
  const dur = props.pcm ? props.pcm.channels[0].length / props.pcm.sampleRate : 0;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      force((x) => x + 1);
      raf = position() != null ? requestAnimationFrame(loop) : 0;
    };
    const off = onPlayerChange(() => {
      cancelAnimationFrame(raf);
      loop();
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = (c.width = c.clientWidth * devicePixelRatio);
    const H = (c.height = (props.height ?? 140) * devicePixelRatio);
    const g = c.getContext('2d')!;
    g.fillStyle = '#11131a';
    g.fillRect(0, 0, W, H);
    if (!props.pcm) return;
    const x = (t: number) => (t / dur) * W;
    for (const r of props.regions ?? []) {
      g.fillStyle = r.active ? 'rgba(255,190,60,.25)' : 'rgba(120,160,255,.14)';
      g.fillRect(x(r.start), 0, x(r.end) - x(r.start), H);
      if (r.label) {
        g.fillStyle = '#bcd';
        g.font = `${11 * devicePixelRatio}px sans-serif`;
        g.fillText(r.label, x(r.start) + 3, 12 * devicePixelRatio);
      }
    }
    const { min, max } = waveformPeaks(toMono(props.pcm), Math.max(1, Math.floor(W)));
    g.fillStyle = '#5ad1b3';
    for (let i = 0; i < min.length; i++) g.fillRect(i, H / 2 - max[i] * (H / 2), 1, Math.max(1, (max[i] - min[i]) * (H / 2)));
    if (props.selection) {
      g.fillStyle = 'rgba(255,255,255,.18)';
      g.fillRect(x(props.selection.start), 0, x(props.selection.end) - x(props.selection.start), H);
    }
    g.fillStyle = '#ff5c8a';
    for (const m of props.markers ?? []) g.fillRect(x(m), 0, devicePixelRatio, H);
    const pos = position();
    if (pos != null) {
      g.fillStyle = '#fff';
      g.fillRect(x(pos - (props.playheadOffset ?? 0)), 0, 2, H);
    }
  });

  const timeAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
  };
  return (
    <canvas
      ref={ref}
      className="waveform"
      style={{ height: props.height ?? 140 }}
      onPointerDown={(e) => {
        if (!props.onSelect) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = timeAt(e);
        props.onSelect({ start: drag.current, end: drag.current });
      }}
      onPointerMove={(e) => {
        if (drag.current == null || !props.onSelect) return;
        const t = timeAt(e);
        props.onSelect({ start: Math.min(drag.current, t), end: Math.max(drag.current, t) });
      }}
      onPointerUp={() => (drag.current = null)}
    />
  );
}

export function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}
