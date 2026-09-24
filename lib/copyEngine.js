import { createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const READ_CHUNK = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;

export function isAbortError(err) {
    return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
    }
}

function joinRel(parent, name) {
    return parent ? `${parent}/${name}` : name;
}

function absFromRel(root, rel) {
    return rel ? path.join(root, ...rel.split('/')) : root;
}

function kindOf(dirent) {
    if (dirent.isSymbolicLink()) return 'symlink';
    if (dirent.isDirectory()) return 'dir';
    if (dirent.isFile()) return 'file';
    return 'other';
}

async function walkTree(root, { signal, onFile, onDir, onSpecial }) {
    async function rec(dir, rel) {
        throwIfAborted(signal);
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (err.code === 'ENOENT') return;
            throw err;
        }
        for (const entry of entries) {
            throwIfAborted(signal);
            const childRel = joinRel(rel, entry.name);
            const full = path.join(dir, entry.name);
            const kind = kindOf(entry);
            if (kind === 'dir') {
                await onDir?.({ rel: childRel, full });
                await rec(full, childRel);
            } else if (kind === 'file') {
                const st = await fsp.stat(full);
                await onFile?.({ rel: childRel, full, size: st.size });
            } else {
                await onSpecial?.({ rel: childRel, full, kind });
            }
        }
    }
    await rec(root, '');
}

async function destStat(dest) {
    try {
        return await fsp.lstat(dest);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

export function folderPlanSummary(folder) {
    return {
        name: folder.name,
        filesToCopy: folder.copies.length,
        bytesToCopy: folder.copies.reduce((n, c) => n + c.size, 0),
        filesToSkip: folder.skips.length,
        filesToDelete: folder.deletes.filter((d) => !d.isDir).length,
    };
}

function folderDeleteStats(folder) {
    let filesToDelete = 0;
    let bytesToDelete = 0;
    for (const item of folder.deletes) {
        if (item.isDir) continue;
        filesToDelete += 1;
        bytesToDelete += item.size;
    }
    return { filesToDelete, bytesToDelete };
}

/**
 * Walk one source folder (and dest, if deleting) and decide what to copy / skip / delete.
 * Identity is relative path + size. No timestamps.
 */
export async function planFolder({ sourceBase, destBase, name, del, signal, onSpecial }) {
    throwIfAborted(signal);
    const srcRoot = path.join(sourceBase, name);
    const destRoot = path.join(destBase, name);
    const copies = [];
    const skips = [];
    const deletes = [];
    const sourceFiles = new Set();
    const sourceDirs = new Set();

    await walkTree(srcRoot, {
        signal,
        onDir: ({ rel }) => {
            sourceDirs.add(rel);
        },
        onFile: async ({ rel, full, size }) => {
            sourceFiles.add(rel);
            const dest = absFromRel(destRoot, rel);
            const st = await destStat(dest);
            if (st && st.isFile() && st.size === size) {
                skips.push({ rel, size });
                return;
            }
            copies.push({ rel, size, src: full, dest });
        },
        onSpecial: async (entry) => {
            await onSpecial?.({ folder: name, ...entry, side: 'source' });
        },
    });

    if (del) {
        await walkTree(destRoot, {
            signal,
            onDir: ({ rel, full }) => {
                if (!sourceDirs.has(rel)) {
                    deletes.push({ rel, dest: full, size: 0, isDir: true });
                }
            },
            onFile: async ({ rel, full, size }) => {
                if (!sourceFiles.has(rel)) {
                    deletes.push({ rel, dest: full, size, isDir: false });
                }
            },
            onSpecial: async ({ rel, full, kind }) => {
                deletes.push({ rel, dest: full, size: 0, isDir: false, kind });
            },
        });
        // Deepest paths first so files go before their parent dirs.
        deletes.sort((a, b) => b.rel.length - a.rel.length || b.rel.localeCompare(a.rel));
    }

    return {
        name,
        srcRoot,
        destRoot,
        copies,
        skips,
        deletes,
        sourceDirs: [...sourceDirs],
    };
}

/**
 * Walk source (and dest, if deleting) and decide what to copy / skip / delete.
 * Identity is relative path + size. No timestamps.
 * Calls onFolderStart(name) before each folder and onFolder(folder, totals) after.
 */
export async function planJob({
    sourceBase,
    destBase,
    folders,
    del,
    signal,
    onSpecial,
    onFolderStart,
    onFolder,
}) {
    const planned = [];
    let filesToCopy = 0;
    let bytesToCopy = 0;
    let filesToSkip = 0;
    let filesToDelete = 0;
    let bytesToDelete = 0;

    for (const name of folders) {
        throwIfAborted(signal);
        await onFolderStart?.(name);
        const folder = await planFolder({
            sourceBase,
            destBase,
            name,
            del,
            signal,
            onSpecial,
        });
        planned.push(folder);
        filesToCopy += folder.copies.length;
        bytesToCopy += folder.copies.reduce((n, c) => n + c.size, 0);
        filesToSkip += folder.skips.length;
        const delStats = folderDeleteStats(folder);
        filesToDelete += delStats.filesToDelete;
        bytesToDelete += delStats.bytesToDelete;
        await onFolder?.(folder, {
            filesToCopy,
            bytesToCopy,
            filesToSkip,
            filesToDelete,
            bytesToDelete,
        });
    }

    return {
        sourceBase,
        destBase,
        del: !!del,
        folders: planned,
        filesToCopy,
        bytesToCopy,
        filesToSkip,
        filesToDelete,
        bytesToDelete,
    };
}

export function summarizePlan(plan) {
    return {
        filesToCopy: plan.filesToCopy,
        bytesToCopy: plan.bytesToCopy,
        filesToSkip: plan.filesToSkip,
        filesToDelete: plan.filesToDelete,
        bytesToDelete: plan.bytesToDelete,
        folders: plan.folders.map(folderPlanSummary),
    };
}

async function copyFile(src, dest, { signal, onBytes }) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const existing = await destStat(dest);
    if (existing) {
        if (existing.isDirectory()) {
            await fsp.rm(dest, { recursive: true, force: true });
        } else if (!existing.isFile()) {
            await fsp.rm(dest, { force: true });
        }
    }

    const rs = createReadStream(src, { highWaterMark: READ_CHUNK });
    const ws = createWriteStream(dest);
    if (onBytes) {
        rs.on('data', (chunk) => onBytes(chunk.length));
    }
    try {
        await pipeline(rs, ws, { signal });
    } catch (err) {
        ws.destroy();
        rs.destroy();
        throw err;
    }
}

function folderSpecsFromPlan(plan) {
    return plan.folders.map((f) => ({
        name: f.name,
        bytesToCopy: f.copies.reduce((n, c) => n + c.size, 0),
        filesToCopy: f.copies.length,
    }));
}

export function initialProgress(plan) {
    const folders = folderSpecsFromPlan(plan).map((f) => ({
        ...f,
        bytesCopied: 0,
        filesDone: 0,
        percent: 0,
        status: 'pending',
    }));
    return {
        type: 'progress',
        percent: plan.bytesToCopy === 0 ? 100 : 0,
        bytesCopied: 0,
        bytesToCopy: plan.bytesToCopy,
        filesDone: 0,
        filesToCopy: plan.filesToCopy,
        folder: '',
        file: '',
        speedBps: 0,
        etaSec: null,
        folders,
    };
}

function makeProgressTracker({ plan, onProgress }) {
    const bytesToCopy = plan.bytesToCopy;
    const folderState = new Map(
        folderSpecsFromPlan(plan).map((f) => [
            f.name,
            {
                name: f.name,
                bytesCopied: 0,
                bytesToCopy: f.bytesToCopy,
                filesDone: 0,
                filesToCopy: f.filesToCopy,
                status: 'pending',
            },
        ])
    );
    let bytesCopied = 0;
    let filesDone = 0;
    let lastEmit = 0;
    let startedAt = 0;
    let lastBytes = 0;
    let lastTick = 0;
    let speedBps = 0;

    function folderList() {
        return [...folderState.values()].map((s) => ({
            ...s,
            percent:
                s.bytesToCopy === 0
                    ? s.status === 'pending'
                        ? 0
                        : 100
                    : Math.min(100, (s.bytesCopied / s.bytesToCopy) * 100),
        }));
    }

    function snapshot({ folder, file, force }) {
        const now = Date.now();
        if (!startedAt && bytesCopied > 0) {
            startedAt = now;
            lastTick = now;
            lastBytes = bytesCopied;
        }
        if (startedAt && now - lastTick >= 200) {
            const inst = (bytesCopied - lastBytes) / ((now - lastTick) / 1000);
            speedBps = speedBps ? speedBps * 0.7 + inst * 0.3 : inst;
            lastBytes = bytesCopied;
            lastTick = now;
        }
        if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
        lastEmit = now;

        const percent =
            bytesToCopy === 0 ? 100 : Math.min(100, (bytesCopied / bytesToCopy) * 100);
        const remaining = Math.max(0, bytesToCopy - bytesCopied);
        const etaSec = speedBps > 0 ? remaining / speedBps : null;

        onProgress?.({
            type: 'progress',
            percent,
            bytesCopied,
            bytesToCopy,
            filesDone,
            filesToCopy: plan.filesToCopy,
            folder: folder || '',
            file: file || '',
            speedBps,
            etaSec,
            folders: folderList(),
        });
    }

    return {
        addBytes(n, ctx) {
            bytesCopied += n;
            const st = ctx.folder && folderState.get(ctx.folder);
            if (st) {
                st.bytesCopied += n;
                st.status = 'running';
            }
            snapshot({ ...ctx, force: false });
        },
        fileDone(ctx) {
            filesDone += 1;
            const st = ctx.folder && folderState.get(ctx.folder);
            if (st) {
                st.filesDone += 1;
                st.status = 'running';
            }
            snapshot({ ...ctx, force: true });
        },
        folderStart(name) {
            const st = folderState.get(name);
            if (st && st.status === 'pending') st.status = 'running';
            snapshot({ folder: name, file: '', force: true });
        },
        folderDone(name) {
            const st = folderState.get(name);
            if (st) st.status = 'done';
            snapshot({ folder: name, file: '', force: true });
        },
        snapshot,
    };
}

async function measureTree(root, signal) {
    let files = 0;
    let size = 0;
    await walkTree(root, {
        signal,
        onFile: ({ size: n }) => {
            files += 1;
            size += n;
        },
    });
    return { files, size };
}

/**
 * Execute a plan produced by planJob.
 * onProgress({ percent, bytesCopied, bytesToCopy, filesDone, filesToCopy, folder, file, speedBps, etaSec })
 * onFile({ action: 'copy'|'skip'|'delete'|'error'|'special', folder, file, size, message? })
 * onFolderDone({ folder, files_copied, files_after, folder_size })
 */
export async function runPlan(plan, { onProgress, onFile, onFolderDone, signal }) {
    const tracker = makeProgressTracker({ plan, onProgress });

    for (const folder of plan.folders) {
        throwIfAborted(signal);
        tracker.folderStart(folder.name);

        if (plan.del && folder.deletes.length) {
            for (const item of folder.deletes) {
                throwIfAborted(signal);
                try {
                    await fsp.rm(item.dest, { recursive: item.isDir, force: true });
                    if (!item.isDir) {
                        onFile?.({
                            action: 'delete',
                            folder: folder.name,
                            file: item.rel,
                            size: item.size,
                        });
                    }
                } catch (err) {
                    onFile?.({
                        action: 'error',
                        folder: folder.name,
                        file: item.rel,
                        size: item.size,
                        message: `delete failed: ${err.message}`,
                    });
                    throw err;
                }
            }
        }

        for (const rel of folder.sourceDirs) {
            throwIfAborted(signal);
            const destDir = absFromRel(folder.destRoot, rel);
            const st = await destStat(destDir);
            if (st && !st.isDirectory()) {
                await fsp.rm(destDir, { force: true });
            }
            await fsp.mkdir(destDir, { recursive: true });
        }
        await fsp.mkdir(folder.destRoot, { recursive: true });

        if (folder.skips.length) {
            onFile?.({
                action: 'skip',
                folder: folder.name,
                file: '',
                size: 0,
                count: folder.skips.length,
                message: `skipped ${folder.skips.length} file${folder.skips.length === 1 ? '' : 's'} (same path + size)`,
            });
        }

        for (const item of folder.copies) {
            throwIfAborted(signal);
            const ctx = { folder: folder.name, file: item.rel };
            tracker.snapshot({ ...ctx, force: true });
            try {
                await copyFile(item.src, item.dest, {
                    signal,
                    onBytes: (n) => tracker.addBytes(n, ctx),
                });
                tracker.fileDone(ctx);
                onFile?.({
                    action: 'copy',
                    folder: folder.name,
                    file: item.rel,
                    size: item.size,
                });
            } catch (err) {
                if (isAbortError(err)) throw err;
                onFile?.({
                    action: 'error',
                    folder: folder.name,
                    file: item.rel,
                    size: item.size,
                    message: err.message,
                });
                throw err;
            }
        }

        const dest = await measureTree(folder.destRoot, signal);
        await onFolderDone?.({
            folder: folder.name,
            files_copied: folder.copies.length,
            files_after: dest.files,
            folder_size: dest.size,
        });
        tracker.folderDone(folder.name);
    }

    tracker.snapshot({ folder: '', file: '', force: true });
}
