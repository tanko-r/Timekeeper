#!/usr/bin/env bash
# Install Timekeeper as a systemd *user* service (starts at boot via lingering).
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p ~/.config/systemd/user
cp timekeeper.service ~/.config/systemd/user/timekeeper.service
systemctl --user daemon-reload
systemctl --user enable --now timekeeper.service
sleep 1
systemctl --user --no-pager status timekeeper.service | head -8
echo
echo "Timekeeper is up: http://$(hostname -I | awk '{print $1}'):4747"
