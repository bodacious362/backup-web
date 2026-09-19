import React, { useEffect, useMemo, useRef, useState } from 'react'
import { bytes, duration, percent } from './format.js'

function Bar({ value, size = 'md' }) {
    const w = Math.min(100, Math.max(0, value ?? 0))
    return (
        <div
            className={`xfer-bar ${size}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={w}
            role="progressbar"
        >
            <div className="xfer-fill" style={{ width: `${w}%` }} />
        </div>
    )
}

const api = (p, opts) => fetch(p, opts).then(async (r) => {
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
})

export default function App() {
    const [config, setConfig] = useState(null)
    const [drives, setDrives] = useState([])
    const [folders, setFolders] = useState([])
    const [loadingDrives, setLoadingDrives] = useState(true)
    const [loadingFolders, setLoadingFolders] = useState(true)
    const [error, setError] = useState('')

    const [selectedDrive, setSelectedDrive] = useState('')
    const [selected, setSelected] = useState(() => new Set())
    const [del, setDel] = useState(false)

    const [confirming, setConfirming] = useState(false)
    const [job, setJob] = useState(null) // { id, status }
    const [log, setLog] = useState([])
    const [progress, setProgress] = useState(null)
    const [preflight, setPreflight] = useState(null)
    const [stopping, setStopping] = useState(false)
    const logRef = useRef(null)
    const esRef = useRef(null)

    const running = job && job.status === 'running'

    // ── Load drives + folders ──────────────────────────────────────────────
    async function loadDrives() {
        setLoadingDrives(true)
        try {
            const d = await api('/api/drives')
            setDrives(d.drives)
            // Keep selection if still present
            setSelectedDrive((cur) => (d.drives.some((x) => x.name === cur) ? cur : ''))
        } catch (e) {
            setError(e.message)
        } finally {
            setLoadingDrives(false)
        }
    }

    async function loadFolders() {
        setLoadingFolders(true)
        try {
            const f = await api('/api/folders')
            setFolders(f.folders)
        } catch (e) {
            setError(e.message)
        } finally {
            setLoadingFolders(false)
        }
    }

    useEffect(() => {
        api('/api/config').then(setConfig).catch(() => { })
        loadDrives()
        loadFolders()
        return () => esRef.current && esRef.current.close()
    }, [])

    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    }, [log])

    const totalSelectedSize = useMemo(
        () =>
            folders
                .filter((f) => selected.has(f.name))
                .reduce((sum, f) => sum + (f.size || 0), 0),
        [folders, selected]
    )

    const folderBars = useMemo(() => {
        if (progress?.folders?.length) return progress.folders
        if (preflight?.folders?.length) {
            return preflight.folders.map((f) => ({
                ...f,
                bytesCopied: 0,
                filesDone: 0,
                percent: 0,
                status: 'pending',
            }))
        }
        if (job) {
            return [...selected].sort().map((name) => ({
                name,
                bytesCopied: 0,
                bytesToCopy: null,
                filesDone: 0,
                filesToCopy: null,
                percent: 0,
                status: 'pending',
            }))
        }
        return []
    }, [progress, preflight, job, selected])

    const drive = drives.find((d) => d.name === selectedDrive)
    const fitsWarning =
        drive && drive.usage && totalSelectedSize > drive.usage.avail

    function toggle(name) {
        setSelected((s) => {
            const next = new Set(s)
            next.has(name) ? next.delete(name) : next.add(name)
            return next
        })
    }

    function toggleAll() {
        setSelected((s) =>
            s.size === folders.length ? new Set() : new Set(folders.map((f) => f.name))
        )
    }

    // ── Start copy ─────────────────────────────────────────────────────────
    async function startCopy() {
        setConfirming(false)
        setError('')
        setLog([])
        setProgress(null)
        setPreflight(null)
        setStopping(false)
        try {
            const { jobId } = await api('/api/copy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    drive: selectedDrive,
                    folders: [...selected],
                    del,
                }),
            })
            setJob({ id: jobId, status: 'running' })

            const es = new EventSource(`/api/copy/${jobId}/stream`)
            esRef.current = es
            es.addEventListener('preflight', (ev) => {
                setPreflight(JSON.parse(ev.data))
            })
            es.addEventListener('progress', (ev) => {
                setProgress(JSON.parse(ev.data))
            })
            es.addEventListener('line', (ev) => {
                const line = JSON.parse(ev.data)
                setLog((l) => [...l, line])
            })
            es.addEventListener('done', (ev) => {
                const { status } = JSON.parse(ev.data)
                setJob((j) => (j ? { ...j, status } : j))
                es.close()
                loadDrives() // refresh free space
            })
            es.onerror = () => {
                // stream dropped; leave whatever we have
            }
        } catch (e) {
            setError(e.message)
        }
    }

    async function stopCopy() {
        if (!job?.id || !running || stopping) return
        setStopping(true)
        try {
            await api(`/api/copy/${job.id}/cancel`, { method: 'POST' })
        } catch (e) {
            setStopping(false)
            setError(e.message)
        }
    }

    const canCopy = selectedDrive && selected.size > 0 && !running

    return (
        <div className="wrap">
            <header>
                <h1>USB Copy</h1>
                {config && (
                    <p className="sub">
                        Source <code>{config.sourceBase}</code> → drives under{' '}
                        <code>{config.mountBase}</code>
                    </p>
                )}
            </header>

            {error && (
                <div className="banner err">
                    {error} <button onClick={() => setError('')}>dismiss</button>
                </div>
            )}

            {/* ── Drives ─────────────────────────────────────────────── */}
            <section className="card">
                <div className="card-head">
                    <h2>1 · Destination drive</h2>
                    <button className="ghost" onClick={loadDrives} disabled={running}>
                        ↻ Refresh
                    </button>
                </div>
                {loadingDrives ? (
                    <p className="muted">Scanning…</p>
                ) : drives.length === 0 ? (
                    <p className="muted">
                        No mounted drives found under {config?.mountBase || '/mnt'}.
                    </p>
                ) : (
                    <ul className="drives">
                        {drives.map((d) => (
                            <li key={d.name}>
                                <label className={selectedDrive === d.name ? 'sel' : ''}>
                                    <input
                                        type="radio"
                                        name="drive"
                                        checked={selectedDrive === d.name}
                                        onChange={() => setSelectedDrive(d.name)}
                                        disabled={running}
                                    />
                                    <span className="dname">{d.name}</span>
                                    {d.usage && (
                                        <span className="usage">
                                            {bytes(d.usage.avail)} free of {bytes(d.usage.size)}
                                        </span>
                                    )}
                                </label>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* ── Folders ────────────────────────────────────────────── */}
            <section className="card">
                <div className="card-head">
                    <h2>2 · Folders to copy</h2>
                    <div className="head-actions">
                        {folders.length > 0 && (
                            <button className="ghost" onClick={toggleAll} disabled={running}>
                                {selected.size === folders.length ? 'Clear all' : 'Select all'}
                            </button>
                        )}
                        <button className="ghost" onClick={loadFolders} disabled={running}>
                            ↻ Refresh
                        </button>
                    </div>
                </div>
                {loadingFolders ? (
                    <p className="muted">Reading source…</p>
                ) : folders.length === 0 ? (
                    <p className="muted">No folders in source.</p>
                ) : (
                    <ul className="folders">
                        {folders.map((f) => (
                            <li key={f.name}>
                                <label className={selected.has(f.name) ? 'sel' : ''}>
                                    <input
                                        type="checkbox"
                                        checked={selected.has(f.name)}
                                        onChange={() => toggle(f.name)}
                                        disabled={running}
                                    />
                                    <span className="fname">{f.name}</span>
                                    <span className="fsize">{bytes(f.size)}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* ── Options ────────────────────────────────────────────── */}
            <section className="card">
                <h2>3 · Options</h2>
                <label className={`delete-opt ${del ? 'on' : ''}`}>
                    <input
                        type="checkbox"
                        checked={del}
                        onChange={(e) => setDel(e.target.checked)}
                        disabled={running}
                    />
                    <span>
                        <strong>Delete extraneous files on the destination</strong>
                        <small>
                            Makes each copied folder a mirror of the source: files on the drive
                            that aren't in the source are removed. Off = copy missing or
                            different-size files, never delete extras.
                        </small>
                    </span>
                </label>
            </section>

            {/* ── Summary + action ───────────────────────────────────── */}
            <section className="card summary">
                <div className="sumrow">
                    <span>Selected</span>
                    <strong>
                        {selected.size} folder{selected.size === 1 ? '' : 's'} ·{' '}
                        {bytes(totalSelectedSize)}
                    </strong>
                </div>
                <div className="sumrow">
                    <span>Destination</span>
                    <strong>{selectedDrive || '—'}</strong>
                </div>
                <div className="sumrow">
                    <span>Mode</span>
                    <strong className={del ? 'danger' : ''}>
                        {del ? 'Mirror (delete extras)' : 'Copy if missing or size differs'}
                    </strong>
                </div>
                {fitsWarning && (
                    <div className="banner warn">
                        Selection ({bytes(totalSelectedSize)}) is larger than free space (
                        {bytes(drive.usage.avail)}). This is an upper bound — files already on
                        the drive won't be recopied — but it may not fit.
                    </div>
                )}
                {running ? (
                    <button className="go stop-btn" disabled={stopping} onClick={stopCopy}>
                        {stopping ? 'Stopping…' : 'Stop'}
                    </button>
                ) : (
                    <button className="go" disabled={!canCopy} onClick={() => setConfirming(true)}>
                        Copy
                    </button>
                )}
            </section>

            {/* ── Live log ───────────────────────────────────────────── */}
            {(log.length > 0 || job) && (
                <section className="card">
                    <div className="card-head">
                        <h2>Progress</h2>
                        <div className="head-actions">
                            {running && (
                                <button className="stop-btn compact" disabled={stopping} onClick={stopCopy}>
                                    {stopping ? 'Stopping…' : 'Stop'}
                                </button>
                            )}
                            {job && (
                                <span className={`status ${stopping && running ? 'cancelled' : job.status}`}>
                                    {stopping && running
                                        ? 'stopping'
                                        : job.status === 'running'
                                            ? 'running'
                                            : job.status === 'done'
                                                ? 'done ✓'
                                                : job.status === 'cancelled'
                                                    ? 'cancelled'
                                                    : 'error ✗'}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="xfer">
                        <div className="xfer-total">
                            <div className="xfer-row">
                                <span className="xfer-name">Total</span>
                                <strong>{percent(progress?.percent ?? 0)}</strong>
                            </div>
                            <Bar value={progress?.percent ?? 0} size="lg" />
                            <div className="xfer-meta">
                                <span>
                                    {bytes(progress?.bytesCopied ?? 0)} / {bytes(progress?.bytesToCopy)}
                                </span>
                                <span>
                                    {progress
                                        ? `${progress.filesDone}/${progress.filesToCopy} files`
                                        : 'Scanning…'}
                                </span>
                                <span>
                                    {progress?.speedBps > 0 ? `${bytes(progress.speedBps)}/s` : '—'}
                                </span>
                                <span>ETA {duration(progress?.etaSec)}</span>
                            </div>
                        </div>
                        {folderBars.length > 0 && (
                            <ul className="xfer-folders">
                                {folderBars.map((f) => {
                                    const active = progress?.folder === f.name
                                    return (
                                        <li key={f.name} className={`xfer-folder ${f.status || ''} ${active ? 'active' : ''}`}>
                                            <div className="xfer-row">
                                                <span className="xfer-name">{f.name}</span>
                                                <span className="xfer-pct">{percent(f.percent ?? 0)}</span>
                                            </div>
                                            <Bar value={f.percent ?? 0} size="sm" />
                                            <div className="xfer-meta">
                                                <span>
                                                    {bytes(f.bytesCopied ?? 0)} / {bytes(f.bytesToCopy)}
                                                </span>
                                                <span>
                                                    {f.filesDone ?? 0}/{f.filesToCopy ?? 0} files
                                                </span>
                                                {active && progress?.file ? (
                                                    <span className="xfer-file-inline">{progress.file}</span>
                                                ) : f.status === 'done' ? (
                                                    <span>done</span>
                                                ) : f.status === 'running' ? (
                                                    <span>copying</span>
                                                ) : (
                                                    <span>waiting</span>
                                                )}
                                            </div>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}
                        {job?.status === 'running' && !progress && (
                            <p className="xfer-file muted">Comparing path and size…</p>
                        )}
                    </div>
                    {preflight?.fits === false && (
                        <div className="banner warn">
                            Preflight needs {bytes(preflight.bytesToCopy)} but the drive has{' '}
                            {bytes(preflight.avail)} free.
                        </div>
                    )}
                    <pre className="log" ref={logRef}>
                        {log.map((l, i) => (
                            <div key={i} className={`ln ${l.type}`}>
                                {l.text}
                            </div>
                        ))}
                    </pre>
                    {job && job.status !== 'running' && (
                        <button className="ghost" onClick={() => { setJob(null); setLog([]); setProgress(null); setPreflight(null); setStopping(false) }}>
                            Clear
                        </button>
                    )}
                </section>
            )}

            {/* ── Confirm dialog ─────────────────────────────────────── */}
            {confirming && (
                <div className="modal-bg" onClick={() => setConfirming(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h3>Confirm copy</h3>
                        <p>
                            Copy <strong>{selected.size}</strong> folder
                            {selected.size === 1 ? '' : 's'} ({bytes(totalSelectedSize)}) to{' '}
                            <strong>{selectedDrive}</strong>.
                        </p>
                        {del ? (
                            <p className="danger">
                                ⚠ Mirror mode: files on the drive that aren't in the source
                                (inside the copied folders) will be <strong>deleted</strong>.
                            </p>
                        ) : (
                            <p className="muted">
                                Files with the same path and size are skipped; anything else is
                                copied or overwritten. Nothing on the drive is deleted. The source
                                is never modified.
                            </p>
                        )}
                        <ul className="confirm-list">
                            {[...selected].sort().map((n) => (
                                <li key={n}>{n}</li>
                            ))}
                        </ul>
                        <div className="modal-actions">
                            <button className="ghost" onClick={() => setConfirming(false)}>
                                Cancel
                            </button>
                            <button className={del ? 'go danger-btn' : 'go'} onClick={startCopy}>
                                {del ? 'Copy & delete extras' : 'Copy'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <footer>
                Source is only ever read — the copy never modifies <code>{config?.sourceBase || '/mnt/MEDIA'}</code>.
            </footer>
        </div>
    )
}