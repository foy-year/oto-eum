import { useEffect, useState } from 'react';
import { type Tab, projects, useStore } from './store';
import { Library } from './panels/Library';
import { SoundEditor } from './panels/SoundEditor';
import { MidiExtract } from './panels/MidiExtract';
import { MidiEditor } from './panels/MidiEditor';
import { SoundApplier } from './panels/SoundApplier';
import { Effector } from './panels/Effector';
import { VideoSync } from './panels/VideoSync';
import { VideoEditor } from './panels/VideoEditor';
import { Cloud } from './panels/Cloud';
import type { ProjectSummary } from '../core/storage/mediaStore';

const TABS: { id: Tab; label: string }[] = [
  { id: 'library', label: '1 · Library' },
  { id: 'sound', label: '2 · Sound Editor' },
  { id: 'extract', label: '3 · MIDI Extractor' },
  { id: 'midi', label: '4 · MIDI Editor' },
  { id: 'apply', label: '5 · Sound Applier' },
  { id: 'fx', label: '6 · Sound Effector' },
  { id: 'sync', label: '7 · Video Synchronizer' },
  { id: 'video', label: '8 · Video Editor' },
  { id: 'cloud', label: '☁ Cloud & Sharing' },
];

export function App() {
  const { tab, setTab, busy, error, setError, init, project, update, newProject, loadProject, cloud, conflict, readOnly, reloadProject, saveNow } = useStore();
  const [list, setList] = useState<ProjectSummary[]>([]);
  useEffect(() => void init(), []);
  const support = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  return (
    <div className="app">
      <header className="top">
        <h1>
          oto-eum <small>音MAD toolkit</small>
        </h1>
        <input className="pname" value={project.name} onChange={(e) => update((p) => void (p.name = e.target.value))} />
        <button onClick={newProject}>New project</button>
        <select
          value=""
          onFocus={() => projects.list().then(setList)}
          onChange={(e) => e.target.value && void loadProject(e.target.value).catch((err) => setError(String(err.message ?? err)))}
        >
          <option value="">Open project…</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.role && p.role !== 'owner' ? ` — ${p.ownerName}'s (${p.role})` : ''}
            </option>
          ))}
        </select>
        <button className={cloud ? 'on' : ''} onClick={() => setTab('cloud')} title={cloud ? `Signed in to ${cloud.url}` : 'Local mode: files stay in this browser'}>
          {cloud ? `☁ ${cloud.user.name}` : '💾 Local'}
        </button>
        <span className="stats">
          {project.tracks.length} tracks · {project.samples.length} samples · {project.bpm} BPM
        </span>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={t.id === tab ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {!support && <div className="error">This browser lacks WebCodecs — video decoding/export will not work. Use a recent Chrome, Edge, Firefox or Safari.</div>}
      {readOnly && <div className="notice">👁 View-only: you were given viewer access to this project, changes won't be saved.</div>}
      {conflict && (
        <div className="error">
          ⚠ {conflict} <button onClick={() => void reloadProject()}>Load their version</button>{' '}
          <button onClick={() => void saveNow(true)}>Overwrite with mine</button>
        </div>
      )}
      {busy && <div className="busy">⏳ {busy}</div>}
      {error && (
        <div className="error" onClick={() => setError(undefined)}>
          ⚠ {error} <small>(click to dismiss)</small>
        </div>
      )}
      <main>
        {tab === 'library' && <Library />}
        {tab === 'sound' && <SoundEditor />}
        {tab === 'extract' && <MidiExtract />}
        {tab === 'midi' && <MidiEditor />}
        {tab === 'apply' && <SoundApplier />}
        {tab === 'fx' && <Effector />}
        {tab === 'sync' && <VideoSync />}
        {tab === 'video' && <VideoEditor />}
        {tab === 'cloud' && <Cloud />}
      </main>
    </div>
  );
}
