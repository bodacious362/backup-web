import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initialProgress, isAbortError, planJob, runPlan, summarizePlan } from './lib/copyEngine.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────
const SOURCE_BASE = process.env.SOURCE_BASE || '/mnt/MEDIA';
const MOUNT_BASE = process.env.MOUNT_BASE || '/mnt';
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json());

// ── Helpers ─────────────────────────────────────────────────────────────────

// A single path segment: no slashes, no traversal, no hidden/control chars.
// This is the guard against path traversal — every drive/folder name coming
// from the client is checked against the actual on-disk listing AND this.
function isSafeSegment(name) {
    return (
        typeof name === 'string' &&
        name.length > 0 &&
        name !== '.' &&
        name !== '..' &&
        !name.includes('/') &&
        !name.includes('\0')
    );
}

async function isMountpoint(dir) {
    try {
        await execFileP('mountpoint', ['-q', dir]);
        return true;
    } catch {
        return false;
    }
}

// Disk usage for a mountpoint, via df. Returns null if unavailable.
async function diskUsage(dir) {
    try {
        const { stdout } = await execFileP('df', ['-B1', '--output=size,used,avail', dir]);
        const line = stdout.trim().split('\n')[1] || '';
        const [size, used, avail] = line.trim().split(/\s+/).map((n) => parseInt(n, 10));
        if ([size, used, avail].some(Number.isNaN)) return null;
        return { size, used, avail };
    } catch {
        return null;
    }
}

function fmtBytes(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Size of a directory in bytes, via du. Returns null on error.
async function dirSize(dir) {
    try {
        const { stdout } = await execFileP('du', ['-sb', dir]);
        const bytes = parseInt(stdout.trim().split(/\s+/)[0], 10);
        return Number.isNaN(bytes) ? null : bytes;
    } catch {
        return null;
    }
}

// ── API: list mounted USB drives under MOUNT_BASE ────────────────────────────
app.get('/api/drives', async (_req, res) => {
    try {
        const entries = await fsp.readdir(MOUNT_BASE, { withFileTypes: true });
        const drives = [];
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const full = path.join(MOUNT_BASE, e.name);
            // Skip the source itself if it lives under MOUNT_BASE, and skip
            // anything that isn't an actual mount (stray empty dirs, etc.).
            if (path.resolve(full) === path.resolve(SOURCE_BASE)) continue;
            if (!(await isMountpoint(full))) continue;
            const usage = await diskUsage(full);
            drives.push({ name: e.name, path: full, usage });
        }
        drives.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ mountBase: MOUNT_BASE, drives });
    } catch (err) {
        res.status(500).json({ error: `Cannot read ${MOUNT_BASE}: ${err.message}` });
    }
});

// ── API: list folders in the source ──────────────────────────────────────────
app.get('/api/folders', async (_req, res) => {
    try {
        const stat = await fsp.stat(SOURCE_BASE).catch(() => null);
        if (!stat || !stat.isDirectory()) {
            return res.status(404).json({ error: `Source ${SOURCE_BASE} not found` });
        }
        const entries = await fsp.readdir(SOURCE_BASE, { withFileTypes: true });
        const folders = [];
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const size = await dirSize(path.join(SOURCE_BASE, e.name));
            folders.push({ name: e.name, size });
        }
        folders.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ sourceBase: SOURCE_BASE, folders });
    } catch (err) {
        res.status(500).json({ error: `Cannot read ${SOURCE_BASE}: ${err.message}` });
    }
});

// ── Copy jobs ─────────────────────────────────────────────────────────────────
// A job walks + streams files, buffering output so a client can (re)connect
// to the SSE stream and catch up. Progress is a structured percent, not rsync text.
const jobs = new Map();

function newJob({ drive, folders, del }) {
    const id = crypto.randomUUID();
    const job = {
        id,
        drive,
        folders,
        del,
        status: 'running', // running | done | error | cancelled
        lines: [],
        clients: new Set(),
        abort: new AbortController(),
        preflight: null,
        progress: null,
        createdAt: Date.now(),
    };
    jobs.set(id, job);
    return job;
}

function emit(job, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (event === 'line') job.lines.push(data);
    if (event === 'preflight') job.preflight = data;
    if (event === 'progress') job.progress = data;
    for (const client of job.clients) client.write(payload);
}

function finishJob(job, status) {
    if (job.status !== 'running') return;
    job.status = status;
    emit(job, 'done', { status });
}

async function runJob(job) {
    const destBase = path.join(MOUNT_BASE, job.drive);
    const signal = job.abort.signal;

    emit(job, 'line', { type: 'header', text: 'Scanning source and destination…' });

    const plan = await planJob({
        sourceBase: SOURCE_BASE,
        destBase,
        folders: job.folders,
        del: job.del,
        signal,
        onSpecial: ({ folder, rel, kind, side }) => {
            emit(job, 'line', {
                type: 'err',
                text: `Skipping ${kind} (${side}): ${folder}/${rel}`,
            });
        },
    });

    const usage = await diskUsage(destBase);
    const summary = summarizePlan(plan);
    summary.avail = usage?.avail ?? null;
    summary.fits = usage?.avail == null ? null : plan.bytesToCopy <= usage.avail;

    emit(job, 'preflight', summary);
    emit(job, 'line', {
        type: 'header',
        text:
            `Plan: copy ${plan.filesToCopy} file${plan.filesToCopy === 1 ? '' : 's'} ` +
            `(${fmtBytes(plan.bytesToCopy)}), skip ${plan.filesToSkip}` +
            (job.del ? `, delete ${plan.filesToDelete}` : ''),
    });
    if (summary.fits === false) {
        emit(job, 'line', {
            type: 'err',
            text: `Need ${plan.bytesToCopy} bytes but only ${usage.avail} free on the destination.`,
        });
    }

    emit(job, 'progress', initialProgress(plan));

    await runPlan(plan, {
        signal,
        onProgress: (p) => emit(job, 'progress', p),
        onFile: ({ action, folder, file, message }) => {
            if (action === 'copy') {
                emit(job, 'line', { type: 'out', text: `copied ${folder}/${file}` });
            } else if (action === 'delete') {
                emit(job, 'line', { type: 'out', text: `deleted ${folder}/${file}` });
            } else if (action === 'skip') {
                emit(job, 'line', { type: 'out', text: `${folder}: ${message}` });
            } else if (action === 'error') {
                emit(job, 'line', {
                    type: 'err',
                    text: `${folder}/${file}: ${message}`,
                });
            } else {
                emit(job, 'line', { type: 'out', text: message || `${action} ${folder}/${file}` });
            }
        },
    });

    emit(job, 'line', { type: 'header', text: 'Done.' });
    finishJob(job, 'done');
}

// ── API: start a copy job ─────────────────────────────────────────────────────
app.post('/api/copy', async (req, res) => {
    const { drive, folders, del } = req.body || {};

    if (!isSafeSegment(drive)) {
        return res.status(400).json({ error: 'Invalid drive name' });
    }
    if (!Array.isArray(folders) || folders.length === 0) {
        return res.status(400).json({ error: 'No folders selected' });
    }
    if (!folders.every(isSafeSegment)) {
        return res.status(400).json({ error: 'Invalid folder name in selection' });
    }

    // Re-validate against the real filesystem: the drive must be a live mount,
    // and every folder must actually exist in the source. This defends against
    // a client sending names that passed the syntax check but aren't real.
    const destBase = path.join(MOUNT_BASE, drive);
    if (path.resolve(destBase) === path.resolve(SOURCE_BASE)) {
        return res.status(400).json({ error: 'Destination cannot be the source' });
    }
    if (!(await isMountpoint(destBase))) {
        return res.status(400).json({ error: `${destBase} is not a mounted drive` });
    }
    for (const folder of folders) {
        const s = await fsp.stat(path.join(SOURCE_BASE, folder)).catch(() => null);
        if (!s || !s.isDirectory()) {
            return res.status(400).json({ error: `Source folder not found: ${folder}` });
        }
    }

    const job = newJob({ drive, folders, del: !!del });
    res.json({ jobId: job.id });
    // Kick off after responding; clients attach to the SSE stream next.
    runJob(job).catch((err) => {
        if (isAbortError(err) || job.abort.signal.aborted) {
            emit(job, 'line', { type: 'header', text: 'Cancelled.' });
            finishJob(job, 'cancelled');
            return;
        }
        emit(job, 'line', { type: 'err', text: `Job crashed: ${err.message}` });
        finishJob(job, 'error');
    });
});

// ── API: cancel a running job ─────────────────────────────────────────────────
app.post('/api/copy/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'running') {
        return res.json({ jobId: job.id, status: job.status });
    }
    job.abort.abort();
    res.json({ jobId: job.id, status: 'cancelling' });
});

// ── API: SSE stream of a job's output ─────────────────────────────────────────
app.get('/api/copy/:id/stream', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).end();

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.flushHeaders();

    // Replay what already happened so a late/reconnecting client catches up.
    if (job.preflight) {
        res.write(`event: preflight\ndata: ${JSON.stringify(job.preflight)}\n\n`);
    }
    if (job.progress) {
        res.write(`event: progress\ndata: ${JSON.stringify(job.progress)}\n\n`);
    }
    for (const line of job.lines) {
        res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
    }
    if (job.status !== 'running') {
        res.write(`event: done\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
        return res.end();
    }

    job.clients.add(res);
    req.on('close', () => job.clients.delete(res));
});

// ── API: config (source/mount bases for display) ─────────────────────────────
app.get('/api/config', (_req, res) => {
    res.json({ sourceBase: SOURCE_BASE, mountBase: MOUNT_BASE });
});

// ── Static frontend (built by Vite into dist/) ───────────────────────────────
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
    app.get('/', (_req, res) =>
        res
            .status(200)
            .send('<h1>USB Copy</h1><p>Frontend not built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> for development.</p>')
    );
}

app.listen(PORT, HOST, () => {
    console.log(`USB Copy server on http://${HOST}:${PORT}`);
    console.log(`  SOURCE_BASE = ${SOURCE_BASE}`);
    console.log(`  MOUNT_BASE  = ${MOUNT_BASE}`);
});