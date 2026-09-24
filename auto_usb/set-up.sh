#!/bin/bash
# install.sh — run with sudo from anywhere

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

chmod +x "${DIR}/usb-mount.sh"

mkdir -p /mnt/usb

ln -sf "${DIR}/usb-mount.sh"            /usr/local/bin/usb-mount.sh
ln -sf "${DIR}/usb-mount@.service"      /etc/systemd/system/usb-mount@.service
ln -sf "${DIR}/usb-unmount@.service"    /etc/systemd/system/usb-unmount@.service
cp     "${DIR}/99-usb-mount.rules"      /etc/udev/rules.d/99-usb-mount.rules

# Prefer systemd units over sudoers: the web app only starts usb-mount@ / usb-unmount@.
rm -f /etc/sudoers.d/usb-copy-unmount

INSTALL_USER="${SUDO_USER:-${USER}}"
POLKIT_SRC="${DIR}/49-usb-copy-unmount.rules"
POLKIT_DST="/etc/polkit-1/rules.d/49-usb-copy-unmount.rules"
if [[ "${INSTALL_USER}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
    sed "s/@INSTALL_USER@/${INSTALL_USER}/g" "${POLKIT_SRC}" > "${POLKIT_DST}"
    chmod 644 "${POLKIT_DST}"
    echo "Allowed ${INSTALL_USER} to start usb-mount@.service and usb-unmount@.service"
else
    echo "WARNING: skipped polkit rule; unexpected user '${INSTALL_USER}'" >&2
fi

systemctl daemon-reload
udevadm control --reload-rules
udevadm trigger
echo "Installed. Watch: journalctl -t usb-mount -f"