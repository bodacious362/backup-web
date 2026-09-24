#!/bin/bash
# Auto-mount/unmount USB partitions at /mnt/usb/<label>
set -u

ACTION="$1"          # add | remove | unmount
DEVBASE="$2"         # add/remove: sdb1; unmount: mount label
DEVICE="/dev/${DEVBASE}"
MOUNT_ROOT="/mnt/usb"

log() { logger -t usb-mount "$*"; echo "$*" >&2; }

do_mount() {
    if findmnt --source "${DEVICE}" >/dev/null 2>&1; then
        log "${DEVICE} already mounted; skipping"
        return
    fi

    udevadm settle 2>/dev/null

    local tries=0
    while true; do
        unset ID_FS_TYPE ID_FS_LABEL ID_FS_UUID
        eval "$(blkid -o udev "${DEVICE}" 2>/dev/null)"   # -o udev, not -o export
        [ -n "${ID_FS_TYPE:-}" ] && break
        tries=$((tries + 1))
        if [ "${tries}" -ge 10 ]; then
            log "${DEVICE}: no readable filesystem after ${tries}s; skipping"
            return
        fi
        sleep 1
    done

    # Choose a name: label, else fall back to UUID/device
    name="${ID_FS_LABEL:-}"
    [ -z "${name}" ] && name="usb-${ID_FS_UUID:-${DEVBASE}}"
    name="$(echo "${name}" | tr ' /' '__')"

    mount_point="${MOUNT_ROOT}/${name}"
    if mountpoint -q "${mount_point}"; then
        mount_point="${MOUNT_ROOT}/${name}-${DEVBASE}"
    fi
    mkdir -p "${mount_point}"

    opts="rw,relatime,nofail"
    case "${ID_FS_TYPE}" in
        vfat|exfat|ntfs) opts="${opts},uid=1000,gid=1000,umask=002" ;;
    esac

    if mount -o "${opts}" "${DEVICE}" "${mount_point}"; then
        log "Mounted ${DEVICE} at ${mount_point}"
    else
        log "Failed to mount ${DEVICE}"
        rmdir "${mount_point}" 2>/dev/null
    fi
}

do_unmount() {
    if findmnt --source "${DEVICE}" >/dev/null 2>&1; then
        mp="$(findmnt -n -o TARGET --source "${DEVICE}")"
        umount -l "${DEVICE}" && log "Unmounted ${DEVICE} from ${mp}"
        [ -n "${mp}" ] && [ -d "${mp}" ] && rmdir "${mp}" 2>/dev/null
    fi
}

# User-initiated unmount by mount label (e.g. JK_MEDIA → /mnt/usb/JK_MEDIA).
do_unmount_label() {
    local name="$1"
    case "${name}" in
        ""|.|..|*/*|*\\*|*[[:space:]]*)
            log "invalid mount name: ${name}"
            return 1
            ;;
    esac
    local mp="${MOUNT_ROOT}/${name}"
    if [ "$(readlink -f "${mp}")" = "$(readlink -f /mnt/MEDIA)" ]; then
        log "refusing to unmount source ${mp}"
        return 1
    fi
    if ! mountpoint -q "${mp}"; then
        log "${mp} is not a mountpoint"
        return 1
    fi
    local src
    src="$(findmnt -n -o SOURCE --target "${mp}" 2>/dev/null || true)"
    if [ "${src}" = "/dev/mapper/MEDIA" ]; then
        log "refusing to unmount source device ${src}"
        return 1
    fi
    if umount "${mp}"; then
        log "Unmounted ${mp}"
        rmdir "${mp}" 2>/dev/null
        return 0
    fi
    log "Failed to unmount ${mp}"
    return 1
}

case "${ACTION}" in
    add)     do_mount ;;
    remove)  do_unmount ;;
    unmount) do_unmount_label "${DEVBASE}" ;;
    *)       log "Unknown action: ${ACTION}" ;;
esac