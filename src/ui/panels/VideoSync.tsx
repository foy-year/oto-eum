import { useMemo, useState } from 'react';
import { ScenesEditor } from '../ScenesEditor';
import { useStore } from '../store';
import { Check, Num, Pick, Row, Section } from '../widgets';
import { projectVideoScript, videoTracksOf } from '../../core/video/timeline';
import { endTime } from '../../core/midi/midi';
import type { FlipMode, SyncLayout, VideoSyncSettings } from '../../core/types';
import { VideoPreview } from '../VideoPreview';
import { renderMix } from './SoundApplier';

/**
 * Video Synchronizer: every note of a track whose sample comes from a video
 * re-triggers that video region at the note's pitch rate → picture follows sound.
 */
export function VideoSync() {
  const { project, assets, update } = useStore();
  const s = project.videoSync;
  const set = (patch: Partial<VideoSyncSettings>) => update((p) => void (p.videoSync = { ...p.videoSync, ...patch }));
  const script = useMemo(() => projectVideoScript(project, assets, endTime(project.tracks)), [project, assets]);
  const [now, setNow] = useState(0);
  const vtracks = videoTracksOf({ tracks: project.tracks, samples: project.samples, assets, trackIds: project.videoTrackIds });

  return (
    <div className="panel">
      <Section title="Sync settings">
        <Row>
          <Pick
            label="Resolution"
            value={`${s.width}x${s.height}`}
            options={['640x360', '854x480', '1280x720', '1920x1080', '1080x1080', '1080x1920'].map((v) => ({ value: v, label: v }))}
            onChange={(v) => {
              const [w, h] = v.split('x').map(Number);
              set({ width: w, height: h });
            }}
          />
          <Pick label="FPS" value={String(s.fps)} options={['24', '25', '30', '50', '60'].map((v) => ({ value: v, label: v }))} onChange={(v) => set({ fps: +v })} />
          <Pick
            label={project.videoScenes?.length ? 'Layout (overridden by scenes)' : 'Layout'}
            value={s.layout}
            options={(['single', 'grid', 'columns', 'rows'] as SyncLayout[]).map((v) => ({ value: v, label: v }))}
            onChange={(v) => set({ layout: v })}
          />
          <label className="field">
            <span>Background</span>
            <input type="color" value={s.background} onChange={(e) => set({ background: e.target.value })} />
          </label>
        </Row>
        <Row>
          <Pick
            label="Flip per note"
            value={s.flipMode ?? (s.alternateFlip ? 'alternate' : 'none')}
            options={[
              { value: 'alternate', label: 'alternate L/R' },
              { value: 'vertical', label: 'alternate up/down' },
              { value: 'both', label: 'L/R + up/down' },
              { value: 'random', label: 'random' },
              { value: 'none', label: 'none' },
            ]}
            onChange={(v) => set({ flipMode: v as FlipMode })}
          />
          <Check label="Hue by pitch" value={s.hueByPitch} onChange={(v) => set({ hueByPitch: v })} />
          <Check label="Hold last frame until next note" value={s.holdLastFrame} onChange={(v) => set({ holdLastFrame: v })} />
          <Num label="Zoom punch" value={s.punch} step={0.01} min={1} max={2} onChange={(v) => set({ punch: v })} />
          <Num label="Flash" value={s.flash} step={0.05} min={0} max={1} onChange={(v) => set({ flash: v })} />
        </Row>
        <Row>
          <Num label="Rotate ±" value={s.rotate ?? 0} step={1} unit="°" onChange={(v) => set({ rotate: v || undefined })} />
          <Num label="Shake" value={s.shake ?? 0} step={0.01} min={0} max={0.3} onChange={(v) => set({ shake: v || undefined })} />
          <Num label="Zoom drift" value={s.zoomDrift ?? 0} step={0.02} min={0} max={1} onChange={(v) => set({ zoomDrift: v || undefined })} />
          <Check label="Greyscale held frames" value={!!s.greyHeld} onChange={(v) => set({ greyHeld: v || undefined })} />
        </Row>
        <Row>
          <span className="hint">Screen pulse on notes of:</span>
          {project.tracks.map((t) => (
            <Check
              key={t.id}
              label={t.name}
              value={!!s.pulseTrackIds?.includes(t.id)}
              onChange={(v) => set({ pulseTrackIds: v ? [...(s.pulseTrackIds ?? []), t.id] : (s.pulseTrackIds ?? []).filter((x) => x !== t.id) })}
            />
          ))}
        </Row>
        {!!s.pulseTrackIds?.length && (
          <Row>
            <Num label="Pulse flash" value={s.pulseFlash ?? 0.25} step={0.05} min={0} max={1} onChange={(v) => set({ pulseFlash: v })} />
            <Num label="Pulse zoom" value={s.pulseZoom ?? 0.04} step={0.01} min={0} max={0.5} onChange={(v) => set({ pulseZoom: v })} />
            <Num label="Pulse shake" value={s.pulseShake ?? 0} step={0.005} min={0} max={0.1} onChange={(v) => set({ pulseShake: v })} />
          </Row>
        )}
        <p className="hint">
          {vtracks.length
            ? `Video tracks: ${vtracks.map((t) => t.name).join(', ')}. Choose which tracks appear in the Sound Applier ("In video").`
            : 'No track uses a sample cut from a video yet. In the Sound Editor, cut a sample from an uploaded video, then assign it to a track in the Sound Applier.'}
        </p>
      </Section>
      <ScenesEditor now={now} />
      <Section title="Preview & export">
        <VideoPreview events={script.events} extras={script} settings={s} getAudio={() => renderMix()} name={project.name} onTime={setNow} />
      </Section>
    </div>
  );
}
