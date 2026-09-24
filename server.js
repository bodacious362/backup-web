import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    folderPlanSummary,
    initialProgress,
    isAbortError,
    planJob,
    runPlan,
    summarizePlan,
} from './lib/copyEngine.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────
const SOURCE_BASE = process.env.SOURCE_BASE || '/mnt/MEDIA';
const MOUNT_BASE = process.env.MOUNT_BASE || '/mnt/usb';
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BACKUP_LOG = 'backup.log';
const DIRECTIONS = new Set(['to-usb', 'from-usb']);

function normalizeDirection(value) {
    return DIRECTIONS.has(value) ? value : 'to-usb';
}

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

function isSafeDeviceName(name) {
    return typeof name === 'string' && /^sd[a-z]+\d+$/.test(name);
}

function parseUdevProps(text) {
    const props = {};
    for (const line of text.split('\n')) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        props[line.slice(0, i)] = line.slice(i + 1);
    }
    return props;
}

async function udevProps(devPath) {
    const { stdout } = await execFileP('udevadm', ['info', '--query=property', `--name=${devPath}`]);
    return parseUdevProps(stdout);
}

function isUsbDevice(props, tran) {
    return (
        tran === 'usb' ||
        props.ID_BUS === 'usb' ||
        Boolean(props.ID_USB_DRIVER) ||
        Boolean(props.ID_USB_TYPE)
    );
}

function mountNameFromFs({ label, uuid, device }) {
    let name = (label || '').trim();
    if (!name) name = uuid ? `usb-${uuid}` : `usb-${device}`;
    return name.replace(/[ /]/g, '_');
}

function flattenLsblk(devices, parentTran = null, out = []) {
    for (const d of devices || []) {
        const tran = d.tran || parentTran;
        out.push({ ...d, tran });
        if (d.children?.length) flattenLsblk(d.children, tran, out);
    }
    return out;
}

async function sourceOf(dir) {
    try {
        const { stdout } = await execFileP('findmnt', ['-n', '-o', 'SOURCE', '--target', dir]);
        return stdout.trim();
    } catch {
        return '';
    }
}

async function listDrives() {
    const sourcePath = path.resolve(SOURCE_BASE);
    const sourceDev = await sourceOf(SOURCE_BASE);
    const listed = [];
    const seenDev = new Set();

    const entries = await fsp.readdir(MOUNT_BASE, { withFileTypes: true });
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(MOUNT_BASE, e.name);
        if (path.resolve(full) === sourcePath) continue;
        if (!(await isMountpoint(full))) continue;
        const src = await sourceOf(full);
        const device = src.replace(/^\/dev\//, '');
        const usage = await diskUsage(full);
        listed.push({
            name: e.name,
            path: full,
            mounted: true,
            usage,
            device: isSafeDeviceName(device) ? device : null,
            size: usage?.size ?? null,
        });
        if (device) seenDev.add(device);
    }

    const { stdout } = await execFileP('lsblk', [
        '-J',
        '-b',
        '-o',
        'NAME,PATH,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINT,TRAN,SIZE,PKNAME',
    ]);
    const tree = JSON.parse(stdout).blockdevices || [];
    for (const d of flattenLsblk(tree)) {
        if (!isSafeDeviceName(d.name) || seenDev.has(d.name)) continue;
        if (sourceDev && d.path && path.resolve(d.path) === path.resolve(sourceDev)) continue;

        let props = {};
        try {
            props = await udevProps(d.path || `/dev/${d.name}`);
        } catch {
            continue;
        }
        if (!isUsbDevice(props, d.tran)) continue;
        if (props.ID_FS_USAGE && props.ID_FS_USAGE !== 'filesystem') continue;
        if (!props.ID_FS_TYPE && !d.fstype) continue;
        if (d.mountpoint) continue;

        const name = mountNameFromFs({
            label: props.ID_FS_LABEL || d.label,
            uuid: props.ID_FS_UUID || d.uuid,
            device: d.name,
        });
        if (!isSafeSegment(name)) continue;

        listed.push({
            name,
            path: null,
            mounted: false,
            usage: null,
            device: d.name,
            size: Number.isFinite(d.size) ? d.size : null,
        });
    }

    listed.sort((a, b) => {
        if (a.mounted !== b.mounted) return a.mounted ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return listed;
}

// ── API: list USB drives (mounted under MOUNT_BASE, plus unmounted USB) ───────
app.get('/api/drives', async (_req, res) => {
    try {
        const drives = await listDrives();
        res.json({ mountBase: MOUNT_BASE, drives });
    } catch (err) {
        res.status(500).json({ error: `Cannot list drives: ${err.message}` });
    }
});

// ── API: list folders in the copy source ─────────────────────────────────────
// direction=to-usb (default): folders under SOURCE_BASE
// direction=from-usb: folders under the selected USB drive
app.get('/api/folders', async (req, res) => {
    const direction = normalizeDirection(req.query.direction);
    const drive = typeof req.query.drive === 'string' ? req.query.drive : '';

    let sourceBase = SOURCE_BASE;
    if (direction === 'from-usb') {
        if (!isSafeSegment(drive)) {
            return res.status(400).json({ error: 'Select a USB drive first' });
        }
        const usb = await resolveUsbDrive(drive);
        if (usb.error) {
            return res.status(usb.status).json({ error: usb.error });
        }
        sourceBase = usb.usbBase;
    }

    try {
        const stat = await fsp.stat(sourceBase).catch(() => null);
        if (!stat || !stat.isDirectory()) {
            return res.status(404).json({ error: `Source ${sourceBase} not found` });
        }
        const entries = await fsp.readdir(sourceBase, { withFileTypes: true });
        const folders = [];
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const size = await dirSize(path.join(sourceBase, e.name));
            folders.push({ name: e.name, size });
        }
        folders.sort((a, b) => a.name.localeCompare(b.name));
        const destUsage =
            direction === 'from-usb'
                ? await diskUsage(SOURCE_BASE)
                : null;
        res.json({
            sourceBase,
            direction,
            folders,
            destBase: direction === 'from-usb' ? SOURCE_BASE : null,
            destUsage,
        });
    } catch (err) {
        res.status(500).json({ error: `Cannot read ${sourceBase}: ${err.message}` });
    }
});

// ── Copy jobs ─────────────────────────────────────────────────────────────────
// A job walks + streams files, buffering output so a client can (re)connect
// to the SSE stream and catch up. Progress is a structured percent, not rsync text.
const jobs = new Map();

function newJob({ drive, folders, del, direction }) {
    const id = crypto.randomUUID();
    const job = {
        id,
        drive,
        folders,
        del,
        direction: normalizeDirection(direction),
        status: 'running', // running | done | error | cancelled
        lines: [],
        clients: new Set(),
        abort: new AbortController(),
        preflight: null,
        scan: null,
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
    if (event === 'scan') job.scan = data;
    if (event === 'progress') job.progress = data;
    for (const client of job.clients) client.write(payload);
}

function finishJob(job, status) {
    if (job.status !== 'running') return;
    job.status = status;
    emit(job, 'done', { status });
}

function parseBackupLog(text) {
    const byFolder = new Map();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj.folder === 'string') byFolder.set(obj.folder, obj);
        } catch {
            // keep going; a bad line shouldn't block the rest of the log
        }
    }
    return byFolder;
}

async function readBackupLog(destBase) {
    const logPath = path.join(destBase, BACKUP_LOG);
    try {
        const text = await fsp.readFile(logPath, 'utf8');
        return parseBackupLog(text);
    } catch (err) {
        if (err.code === 'ENOENT') return new Map();
        throw err;
    }
}

async function resolveUsbDrive(drive) {
    if (!isSafeSegment(drive)) return { error: 'Invalid drive name', status: 400 };
    const usbBase = path.join(MOUNT_BASE, drive);
    if (path.resolve(usbBase) === path.resolve(SOURCE_BASE)) {
        return { error: 'USB drive cannot be the media source', status: 400 };
    }
    if (!(await isMountpoint(usbBase))) {
        return { error: `${usbBase} is not a mounted drive`, status: 400 };
    }
    return { usbBase };
}

async function resolveCopyBases({ direction, drive }) {
    const usb = await resolveUsbDrive(drive);
    if (usb.error) return usb;
    if (direction === 'from-usb') {
        return {
            sourceBase: usb.usbBase,
            destBase: SOURCE_BASE,
            usbBase: usb.usbBase,
            direction,
        };
    }
    return {
        sourceBase: SOURCE_BASE,
        destBase: usb.usbBase,
        usbBase: usb.usbBase,
        direction: 'to-usb',
    };
}

async function resolveDestDrive(drive) {
    const resolved = await resolveUsbDrive(drive);
    if (resolved.error) return resolved;
    return { destBase: resolved.usbBase };
}

function execErrorMessage(err) {
    const stderr = (err.stderr || '').toString().trim();
    const stdout = (err.stdout || '').toString().trim();
    return stderr || stdout || err.message;
}

async function systemctlUnit(template, instance) {
    const { stdout } = await execFileP('systemd-escape', ['--template', template, instance]);
    return stdout.trim();
}

function systemctlHelperError(detail, kind) {
    if (/not found|not loaded/i.test(detail)) {
        return `${kind} helper is not installed. Re-run sudo auto_usb/set-up.sh.`;
    }
    if (/interactive authentication|access denied|not authorized|permission denied/i.test(detail)) {
        return `Cannot start the USB ${kind} service. Re-run sudo auto_usb/set-up.sh to install the polkit rule.`;
    }
    return null;
}

async function startSystemUnit(template, instance, kind) {
    const unit = await systemctlUnit(template, instance);
    const args = kind === 'mount' ? ['restart', unit] : ['start', unit];
    try {
        await execFileP('systemctl', args);
    } catch (err) {
        const detail = execErrorMessage(err);
        throw new Error(systemctlHelperError(detail, kind) || detail);
    }
}

async function unmountPath(dir) {
    const name = path.basename(dir);
    await startSystemUnit('usb-unmount@.service', name, 'unmount');
    if (await isMountpoint(dir)) {
        throw new Error(`Unmount of ${name} did not complete`);
    }
}

async function mountDevice(device) {
    if (!isSafeDeviceName(device)) {
        const err = new Error('Invalid device name');
        err.status = 400;
        throw err;
    }
    const src = `/dev/${device}`;
    const sourceDev = await sourceOf(SOURCE_BASE);
    if (sourceDev && path.resolve(sourceDev) === path.resolve(src)) {
        const err = new Error('Cannot mount the source');
        err.status = 400;
        throw err;
    }
    let props = {};
    try {
        props = await udevProps(src);
    } catch {
        const err = new Error(`${src} was not found`);
        err.status = 404;
        throw err;
    }
    if (!isUsbDevice(props, null)) {
        const err = new Error('Not a USB drive');
        err.status = 400;
        throw err;
    }
    if (!props.ID_FS_TYPE) {
        const err = new Error('No filesystem on this partition');
        err.status = 400;
        throw err;
    }

    await startSystemUnit('usb-mount@.service', device, 'mount');
    try {
        await execFileP('findmnt', ['--source', src]);
    } catch {
        throw new Error(`Mount of ${device} did not complete`);
    }
}

// ── API: mount a USB partition by device name (e.g. sdb1) ─────────────────────
app.post('/api/drives/:device/mount', async (req, res) => {
    try {
        await mountDevice(req.params.device);
        res.json({ ok: true, device: req.params.device });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.status ? err.message : `Cannot mount ${req.params.device}: ${err.message}`,
        });
    }
});

// ── API: unmount a destination drive ──────────────────────────────────────────
app.post('/api/drives/:drive/unmount', async (req, res) => {
    const resolved = await resolveDestDrive(req.params.drive);
    if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
    }
    const busy = [...jobs.values()].some(
        (j) => j.status === 'running' && j.drive === req.params.drive
    );
    if (busy) {
        return res.status(409).json({
            error: 'Cannot unmount while a copy involving this drive is running',
        });
    }
    try {
        await unmountPath(resolved.destBase);
        res.json({ ok: true, drive: req.params.drive });
    } catch (err) {
        res.status(500).json({ error: `Cannot unmount ${req.params.drive}: ${err.message}` });
    }
});

// ── API: backup history written to the destination drive ──────────────────────
app.get('/api/drives/:drive/history', async (req, res) => {
    const resolved = await resolveDestDrive(req.params.drive);
    if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error });
    }
    try {
        const byFolder = await readBackupLog(resolved.destBase);
        const entries = [...byFolder.values()].sort((a, b) => {
            const ta = Date.parse(a.timestamp) || 0;
            const tb = Date.parse(b.timestamp) || 0;
            return tb - ta;
        });
        res.json({ drive: req.params.drive, entries });
    } catch (err) {
        res.status(500).json({ error: `Cannot read ${BACKUP_LOG}: ${err.message}` });
    }
});

function folderSizeStr(n) {
    if (n == null || Number.isNaN(n)) return '0B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    if (i === 0) return `${Math.round(v)}B`;
    return `${v.toFixed(2)}${units[i]}`;
}

async function writeFolderLog(destBase, entry) {
    const logPath = path.join(destBase, BACKUP_LOG);
    const byFolder = await readBackupLog(destBase);

    byFolder.set(entry.folder, {
        timestamp: new Date().toISOString(),
        folder: entry.folder,
        files_copied: entry.files_copied,
        files_after: entry.files_after,
        folder_size: entry.folder_size,
        folder_size_str: folderSizeStr(entry.folder_size),
    });

    const body = [...byFolder.values()].map((row) => JSON.stringify(row)).join('\n') + '\n';
    const tmp = `${logPath}.tmp`;
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, logPath);
}

async function runJob(job) {
    const bases = await resolveCopyBases({ direction: job.direction, drive: job.drive });
    if (bases.error) throw new Error(bases.error);
    const { sourceBase, destBase, usbBase } = bases;
    const signal = job.abort.signal;

    const scan = {
        phase: 'scanning',
        current: '',
        scanned: 0,
        total: job.folders.length,
        filesToCopy: 0,
        bytesToCopy: 0,
        filesToSkip: 0,
        filesToDelete: 0,
        bytesToDelete: 0,
        folders: job.folders.map((name) => ({
            name,
            status: 'pending',
            filesToCopy: null,
            bytesToCopy: null,
            filesToSkip: null,
            filesToDelete: null,
        })),
    };

    emit(job, 'scan', scan);
    emit(job, 'line', {
        type: 'header',
        text:
            job.direction === 'from-usb'
                ? `Scanning ${usbBase} → ${SOURCE_BASE}…`
                : `Scanning ${SOURCE_BASE} → ${usbBase}…`,
    });

    const plan = await planJob({
        sourceBase,
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
        onFolderStart: (name) => {
            scan.current = name;
            const row = scan.folders.find((f) => f.name === name);
            if (row) row.status = 'scanning';
            emit(job, 'scan', scan);
            emit(job, 'line', { type: 'header', text: `Scanning ${name}…` });
        },
        onFolder: (folder, totals) => {
            const summary = folderPlanSummary(folder);
            Object.assign(scan, totals);
            scan.scanned += 1;
            scan.current = '';
            const row = scan.folders.find((f) => f.name === folder.name);
            if (row) Object.assign(row, summary, { status: 'scanned' });
            emit(job, 'scan', scan);
            emit(job, 'line', {
                type: 'header',
                text:
                    `${folder.name}: copy ${summary.filesToCopy} file` +
                    `${summary.filesToCopy === 1 ? '' : 's'} (${fmtBytes(summary.bytesToCopy)}), ` +
                    `skip ${summary.filesToSkip}` +
                    (job.del ? `, delete ${summary.filesToDelete}` : ''),
            });
        },
    });
    scan.phase = 'done';
    emit(job, 'scan', scan);

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
        onFolderDone: async (entry) => {
            try {
                // Always log on the USB drive so history stays with the removable media.
                await writeFolderLog(usbBase, entry);
                emit(job, 'line', {
                    type: 'out',
                    text: `logged ${entry.folder} → ${BACKUP_LOG}`,
                });
            } catch (err) {
                emit(job, 'line', {
                    type: 'err',
                    text: `Failed to write ${BACKUP_LOG}: ${err.message}`,
                });
            }
        },
    });

    emit(job, 'line', { type: 'header', text: 'Done.' });
    finishJob(job, 'done');
}

// ── API: list currently running copy jobs ─────────────────────────────────────
app.get('/api/copy', (_req, res) => {
    const running = [...jobs.values()]
        .filter((j) => j.status === 'running')
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((j) => ({
            id: j.id,
            drive: j.drive,
            folders: j.folders,
            del: j.del,
            direction: j.direction,
            status: j.status,
            createdAt: j.createdAt,
        }));
    res.json({ jobs: running });
});

// ── API: start a copy job ─────────────────────────────────────────────────────
app.post('/api/copy', async (req, res) => {
    const { drive, folders, del, direction: rawDirection } = req.body || {};
    const direction = normalizeDirection(rawDirection);

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
    const bases = await resolveCopyBases({ direction, drive });
    if (bases.error) {
        return res.status(bases.status).json({ error: bases.error });
    }
    for (const folder of folders) {
        const s = await fsp.stat(path.join(bases.sourceBase, folder)).catch(() => null);
        if (!s || !s.isDirectory()) {
            return res.status(400).json({ error: `Source folder not found: ${folder}` });
        }
    }

    const job = newJob({ drive, folders, del: !!del, direction });
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
    if (job.scan) {
        res.write(`event: scan\ndata: ${JSON.stringify(job.scan)}\n\n`);
    }
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