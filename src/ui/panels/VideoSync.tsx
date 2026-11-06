import { useMemo } from 'react';
import { useStore } from '../store';
import { Check, Num, Pick, Row, Section } from '../widgets';
import { projectVideoEvents, videoTracksOf } from '../../core/video/timeline';
import { endTime } from '../../core/midi/midi';
import type { SyncLayout, VideoSyncSettings } from '../../core/types';
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
  const events = useMemo(() => projectVideoEvents(project, assets, endTime(project.tracks)), [project, assets]);
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
            label="Layout"
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
          <Check label="Alternate flip (L/R mirror per note)" value={s.alternateFlip} onChange={(v) => set({ alternateFlip: v })} />
          <Check label="Hue by pitch" value={s.hueByPitch} onChange={(v) => set({ hueByPitch: v })} />
          <Check label="Hold last frame until next note" value={s.holdLastFrame} onChange={(v) => set({ holdLastFrame: v })} />
          <Num label="Zoom punch" value={s.punch} step={0.01} min={1} max={2} onChange={(v) => set({ punch: v })} />
          <Num label="Flash" value={s.flash} step={0.05} min={0} max={1} onChange={(v) => set({ flash: v })} />
        </Row>
        <p className="hint">
          {vtracks.length
            ? `Video tracks: ${vtracks.map((t) => t.name).join(', ')}. Choose which tracks appear in the Sound Applier ("In video").`
            : 'No track uses a sample cut from a video yet. In the Sound Editor, cut a sample from an uploaded video, then assign it to a track in the Sound Applier.'}
        </p>
      </Section>
      <Section title="Preview & export">
        <VideoPreview events={events} settings={s} getAudio={() => renderMix()} name={project.name} />
      </Section>
    </div>
  );
}
