import { useEffect, useState } from 'react';
import { media, useStore } from '../store';
import { Section, fmt } from '../widgets';
import type { MediaAsset } from '../../core/types';

function Preview({ asset }: { asset: MediaAsset }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let u: string | undefined;
    let cancelled = false;
    void media.getBlob(asset.id).then((b) => {
      if (cancelled) return;
      setUrl((u = URL.createObjectURL(b)));
    });
    return () => {
      cancelled = true;
      // revoke after the media element has been torn down
      if (u) setTimeout(() => URL.revokeObjectURL(u!), 1000);
    };
  }, [asset.id]);
  if (!url) return null;
  return asset.kind === 'video' ? <video src={url} controls className="preview-video" /> : <audio src={url} controls />;
}

export function Library() {
  const { assets, upload, removeAsset, select, selectedAssetId, project, update, setTab } = useStore();
  const [drag, setDrag] = useState(false);
  const sel = assets.find((a) => a.id === selectedAssetId);
  return (
    <div className="panel">
      <Section title="Upload sources">
        <div
          className={`dropzone ${drag ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void upload(e.dataTransfer.files);
          }}
        >
          <p>Drop audio / video files here (mp3, wav, ogg, flac, m4a, mp4, webm, mov, mkv…)</p>
          <input type="file" multiple accept="audio/*,video/*,.mkv,.mov" onChange={(e) => e.target.files && upload(e.target.files)} />
          <small>Files are stored locally in your browser (IndexedDB). Nothing is uploaded to a server.</small>
        </div>
      </Section>
      <Section title={`Library (${assets.length})`}>
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Duration</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} className={a.id === selectedAssetId ? 'sel' : ''} onClick={() => select({ selectedAssetId: a.id })}>
                <td>{a.name}</td>
                <td>
                  {a.kind}
                  {a.width ? ` ${a.width}×${a.height}` : ''}
                  {a.fps ? ` @${a.fps.toFixed(2)}fps` : ''}
                </td>
                <td>{fmt(a.duration)}</td>
                <td>{(a.size / 1e6).toFixed(1)} MB</td>
                <td className="actions">
                  <button onClick={() => (select({ selectedAssetId: a.id }), setTab('sound'))}>Edit sound</button>
                  <button onClick={() => (select({ selectedAssetId: a.id }), setTab('extract'))}>Extract MIDI</button>
                  <button
                    title="Mix this file under the render (e.g. the original song)"
                    className={project.backingAudioId === a.id ? 'on' : ''}
                    onClick={(e) => {
                      e.stopPropagation();
                      update((p) => void (p.backingAudioId = p.backingAudioId === a.id ? undefined : a.id));
                    }}
                  >
                    Backing
                  </button>
                  <button
                    className="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete ${a.name}?`)) void removeAsset(a.id);
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {sel && (
        <Section title={`Preview: ${sel.name}`}>
          <Preview asset={sel} />
        </Section>
      )}
    </div>
  );
}
