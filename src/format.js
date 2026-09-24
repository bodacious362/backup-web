export function bytes(n) {
    if (n == null || Number.isNaN(n)) return '—'
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let i = 0
    let v = n
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
    }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function duration(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—'
    const s = Math.max(0, Math.round(sec))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const r = s % 60
    if (h) return `${h}h ${m}m`
    if (m) return `${m}m ${r}s`
    return `${r}s`
}

export function percent(n) {
    if (n == null || Number.isNaN(n)) return '—'
    const v = Math.min(100, Math.max(0, n))
    return `${v.toFixed(v >= 10 || v === 0 ? 0 : 1)}%`
}

export function when(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    })
}