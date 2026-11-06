import { useEffect, useState } from 'react';
import { cloudApi, job, savedCloud, useStore } from '../store';
import { Check, Pick, Row, Section, fmt } from '../widgets';
import { ApiClient, type Pack, type Report, type Visibility } from '../../core/storage/remote';
import type { MediaAsset } from '../../core/types';

const VIS: { value: Visibility; label: string }[] = [
  { value: 'private', label: 'private' },
  { value: 'unlisted', label: 'unlisted (link)' },
  { value: 'public', label: 'public' },
];
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

/** Report dialog used for media and packs (works signed-out too). */
function ReportButton({ type, id, api }: { type: 'media' | 'pack'; id: string; api: ApiClient }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<'copyright' | 'abuse' | 'other'>('copyright');
  const [details, setDetails] = useState('');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  if (done) return <span className="hint">Reported — thank you.</span>;
  if (!open) return <button onClick={() => setOpen(true)}>Report</button>;
  return (
    <div className="fx">
      <Row>
        <Pick label="Reason" value={reason} options={[{ value: 'copyright', label: 'Copyright infringement' }, { value: 'abuse', label: 'Abuse / illegal content' }, { value: 'other', label: 'Other' }]} onChange={setReason} />
        {!api.token && (
          <label className="field">
            <span>Your email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
      </Row>
      <textarea
        rows={3}
        style={{ width: '100%' }}
        placeholder={reason === 'copyright' ? 'Which work is infringed, and your authority to act for the rights holder…' : 'What is wrong with this item?'}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
      />
      <Row>
        <button onClick={() => job('Sending report…', async () => (await api.report(type, id, reason, details, email || undefined), setDone(true)))}>Send report</button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </Row>
    </div>
  );
}

function SignIn() {
  const { connectCloud } = useStore();
  const [url, setUrl] = useState(savedCloud().url || (location.protocol.startsWith('http') ? location.origin : ''));
  const [status, setStatus] = useState<string>();
  const [policy, setPolicy] = useState<string>();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [accept, setAccept] = useState(false);

  const check = () =>
    job('Contacting server…', async () => {
      const c = new ApiClient(url);
      const h = await c.health();
      setStatus(`Connected ✓ — sign-up ${h.signup ? 'open' : 'closed'}, max upload ${mb(h.maxUploadBytes)}`);
      setPolicy((await c.policy()).text);
    });
  useEffect(() => {
    if (url) void new ApiClient(url).health().then(
      (h) => setStatus(`Connected ✓ — sign-up ${h.signup ? 'open' : 'closed'}, max upload ${mb(h.maxUploadBytes)}`),
      () => setStatus('No oto-eum server found at this address.'),
    );
  }, []);

  const submit = () =>
    job(mode === 'login' ? 'Signing in…' : 'Creating account…', async () => {
      const c = new ApiClient(url);
      const r = mode === 'login' ? await c.login(email, password) : await c.register(email, password, name, accept);
      await connectCloud(c, r.user);
    });

  return (
    <div className="panel">
      <Section title="Cloud server">
        <p className="hint">
          Without a server, everything stays in this browser. Connect to an oto-eum server to store uploads online, use them on any device, share
          projects with collaborators and publish source packs.
        </p>
        <Row>
          <label className="field">
            <span>Server URL</span>
            <input style={{ width: 320 }} value={url} placeholder="https://api.example.com" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <button onClick={check} disabled={!url}>
            Check
          </button>
          <span className="hint">{status}</span>
        </Row>
      </Section>
      <Section title={mode === 'login' ? 'Sign in' : 'Create account'} actions={<button onClick={() => (setMode(mode === 'login' ? 'register' : 'login'), !policy && url && new ApiClient(url).policy().then((p) => setPolicy(p.text), () => {}))}>{mode === 'login' ? 'Need an account?' : 'Have an account?'}</button>}>
        <Row>
          <label className="field">
            <span>Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {mode === 'register' && (
            <label className="field">
              <span>Display name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>Password</span>
            <input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </label>
        </Row>
        {mode === 'register' && (
          <>
            {policy && <pre className="policy">{policy}</pre>}
            <Check label="I accept the content & copyright policy" value={accept} onChange={setAccept} />
          </>
        )}
        <Row>
          <button className="primary" disabled={!url || !email || password.length < (mode === 'register' ? 8 : 1) || (mode === 'register' && !accept)} onClick={submit}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </Row>
      </Section>
    </div>
  );
}

export function Cloud() {
  const { cloud, assets, project, disconnectCloud, refreshAssets, refreshUser, migrateLocalToCloud, saveNow, setTab, loadProject } = useStore();
  const api = cloudApi();
  const [members, setMembers] = useState<Array<{ id: string; name: string; email: string; role: string }>>([]);
  const [shareEmail, setShareEmail] = useState('');
  const [shareRole, setShareRole] = useState<'editor' | 'viewer'>('editor');
  const [myPacks, setMyPacks] = useState<Pack[]>([]);
  const [openPack, setOpenPack] = useState<Pack | null>(null);
  const [publicPacks, setPublicPacks] = useState<Pack[]>([]);
  const [q, setQ] = useState('');
  const [newPack, setNewPack] = useState({ name: '', description: '', visibility: 'unlisted' as Visibility });
  const [reports, setReports] = useState<Report[]>([]);
  const [migrateMsg, setMigrateMsg] = useState('');

  const loadAll = async () => {
    if (!api) return;
    setMyPacks(await api.listPacks('mine'));
    setPublicPacks(await api.listPacks('public', q));
    setMembers(await api.members(project.id).catch(() => []));
    if (cloud?.user.role === 'admin') setReports(await api.adminReports());
  };
  useEffect(() => void loadAll().catch(() => {}), [cloud?.user.id, project.id]);

  if (!cloud || !api) return <SignIn />;
  const u = cloud.user;
  const mine = assets.filter((a) => a.ownerId === u.id);

  return (
    <div className="panel">
      <Section title="Account" actions={<button onClick={() => void disconnectCloud()}>Sign out</button>}>
        <Row>
          <span>
            Signed in to <b>{cloud.url}</b> as <b>{u.name}</b> ({u.email}){u.role === 'admin' ? ' · admin' : ''}
          </span>
        </Row>
        <Row>
          <progress value={u.usedBytes} max={u.quotaBytes} />
          <span className="hint">
            {mb(u.usedBytes)} of {mb(u.quotaBytes)} used
          </span>
        </Row>
        <Row>
          <button
            onClick={() =>
              job('Uploading local library…', async () => {
                const n = await migrateLocalToCloud(setMigrateMsg);
                setMigrateMsg(`Uploaded ${n} local file(s); the current project now uses the cloud copies.`);
              })
            }
          >
            Upload my local (browser) library to the cloud
          </button>
          <span className="hint">{migrateMsg}</span>
        </Row>
      </Section>

      <Section title={`Project “${project.name}”`} actions={<button onClick={() => job('Saving…', () => saveNow())}>Save to cloud now</button>}>
        <p className="hint">Projects autosave to the server. Collaborators can open shared projects from “Open project…”; if two people save at once you’ll be asked which version to keep.</p>
        <Row>
          <label className="field">
            <span>Share with (email)</span>
            <input value={shareEmail} onChange={(e) => setShareEmail(e.target.value)} />
          </label>
          <Pick label="as" value={shareRole} options={[{ value: 'editor', label: 'editor' }, { value: 'viewer', label: 'viewer' }]} onChange={setShareRole} />
          <button
            disabled={!shareEmail}
            onClick={() =>
              job('Sharing…', async () => {
                await saveNow();
                await api.share(useStore.getState().project.id, shareEmail, shareRole);
                setShareEmail('');
                setMembers(await api.members(useStore.getState().project.id));
              })
            }
          >
            Share
          </button>
        </Row>
        {members.length > 0 && (
          <table className="list">
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.email}</td>
                  <td>{m.role}</td>
                  <td className="actions">
                    <button className="danger" onClick={() => job('Removing…', async () => (await api.unshare(project.id, m.id), setMembers(await api.members(project.id))))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`My uploads (${mine.length})`}>
        <table className="list">
          <tbody>
            {mine.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>
                  {a.kind} · {fmt(a.duration)} · {mb(a.size)}
                  {a.status === 'removed' ? ' · ⚠ removed after a report' : ''}
                </td>
                <td>
                  <Pick label="" value={a.visibility} options={VIS} onChange={(v) => job('Updating…', async () => (await api.updateMedia(a.id, { visibility: v }), await refreshAssets()))} />
                </td>
                <td>
                  <Pick
                    label=""
                    value={undefined}
                    placeholder="Add to pack…"
                    options={myPacks.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(id) => id && job('Adding…', async () => (await api.addToPack(id, a.id), await refreshAssets(), await loadAll()))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="My source packs">
        <Row>
          <label className="field">
            <span>Name</span>
            <input value={newPack.name} onChange={(e) => setNewPack({ ...newPack, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Description</span>
            <input style={{ width: 280 }} value={newPack.description} onChange={(e) => setNewPack({ ...newPack, description: e.target.value })} />
          </label>
          <Pick label="" value={newPack.visibility} options={VIS} onChange={(v) => setNewPack({ ...newPack, visibility: v })} />
          <button disabled={!newPack.name} onClick={() => job('Creating pack…', async () => (await api.createPack(newPack.name, newPack.description, newPack.visibility), setNewPack({ name: '', description: '', visibility: 'unlisted' }), await loadAll()))}>
            + Create pack
          </button>
        </Row>
        <table className="list">
          <tbody>
            {myPacks.map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.name}</b> <span className="hint">{p.description}</span>
                </td>
                <td>{p.itemCount} items</td>
                <td>
                  <Pick label="" value={p.visibility} options={VIS} onChange={(v) => job('Updating…', async () => (await api.updatePack(p.id, { visibility: v }), await loadAll(), await refreshAssets()))} />
                </td>
                <td className="actions">
                  <button onClick={() => job('Opening…', async () => setOpenPack(await api.getPack(p.id)))}>Open</button>
                  <button onClick={() => navigator.clipboard?.writeText(p.id)}>Copy ID</button>
                  <button className="danger" onClick={() => confirm(`Delete pack ${p.name}? (files stay in your uploads)`) && job('Deleting…', async () => (await api.deletePack(p.id), await loadAll()))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Browse source packs"
        actions={
          <>
            <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void loadAll()} />
            <button onClick={() => void loadAll()}>Search</button>
            <button
              onClick={() => {
                const id = prompt('Pack ID (for unlisted packs shared with you):');
                if (id) void job('Opening…', async () => setOpenPack(await api.getPack(id.trim())));
              }}
            >
              Open by ID
            </button>
          </>
        }
      >
        <table className="list">
          <tbody>
            {publicPacks.map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.name}</b> <span className="hint">by {p.ownerName} · {p.description}</span>
                </td>
                <td>{p.itemCount} items</td>
                <td className="actions">
                  <button onClick={() => job('Opening…', async () => setOpenPack(await api.getPack(p.id)))}>Open</button>
                  <ReportButton type="pack" id={p.id} api={api} />
                </td>
              </tr>
            ))}
            {publicPacks.length === 0 && (
              <tr>
                <td className="empty">No public packs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      {openPack && (
        <Section title={`Pack: ${openPack.name}`} actions={<button onClick={() => setOpenPack(null)}>Close</button>}>
          <p className="hint">
            by {openPack.ownerName} · {openPack.description} · ID <code>{openPack.id}</code>
          </p>
          <table className="list">
            <tbody>
              {(openPack.items ?? []).map((m: MediaAsset) => {
                const inLib = assets.some((a) => a.id === m.id);
                return (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>
                      {m.kind} · {fmt(m.duration)} · {mb(m.size)}
                    </td>
                    <td className="actions">
                      {openPack.ownerId === u.id ? (
                        <button onClick={() => job('Removing…', async () => setOpenPack(await api.removeFromPack(openPack.id, m.id)))}>Remove from pack</button>
                      ) : (
                        <button disabled={inLib} onClick={() => job('Saving…', async () => (await api.saveToLibrary(m.id), await refreshAssets()))}>
                          {inLib ? 'In your library' : 'Save to my library'}
                        </button>
                      )}
                      <button
                        onClick={() =>
                          job('Saving…', async () => {
                            if (!inLib) await api.saveToLibrary(m.id);
                            await refreshAssets();
                            useStore.getState().select({ selectedAssetId: m.id });
                            setTab('sound');
                          })
                        }
                      >
                        Use
                      </button>
                      {openPack.ownerId !== u.id && <ReportButton type="media" id={m.id} api={api} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}

      {u.role === 'admin' && (
        <Section title={`Moderation — open reports (${reports.length})`} actions={<button onClick={() => void loadAll()}>Refresh</button>}>
          <table className="list">
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.reason}</b> · {r.target_type} <code>{r.target_id}</code>
                    <div className="hint">{r.details}</div>
                    <div className="hint">
                      {r.contact_email} · {new Date(r.created_at).toLocaleString()}
                    </div>
                  </td>
                  <td className="actions">
                    <button onClick={() => job('Opening…', async () => r.target_type === 'pack' && setOpenPack(await api.getPack(r.target_id)))} disabled={r.target_type !== 'pack'}>
                      View
                    </button>
                    <button className="danger" onClick={() => job('Taking down…', async () => (await api.resolveReport(r.id, 'remove', prompt('Note (optional)') ?? ''), await loadAll()))}>
                      Take down
                    </button>
                    <button onClick={() => job('Restoring…', async () => (await api.resolveReport(r.id, 'restore'), await loadAll()))}>Restore</button>
                    <button onClick={() => job('Dismissing…', async () => (await api.resolveReport(r.id, 'dismiss'), await loadAll()))}>Dismiss</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      <p className="hint">
        <button onClick={() => void refreshUser()}>Refresh account</button> · Open shared projects from “Open project…” at the top. <button onClick={() => void loadProject(project.id)}>Reload this project from server</button>
      </p>
    </div>
  );
}
