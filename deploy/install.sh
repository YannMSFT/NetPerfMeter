#!/usr/bin/env bash
# Install WiFi Performance Meter as an always-on systemd service on Raspberry Pi / Debian Linux.
set -euo pipefail

APP_DIR="/opt/wifiperf"
SERVICE_NAME="wifiperf"
SERVICE_FILE="${SERVICE_NAME}.service"
SYSTEMD_DIR="/etc/systemd/system"
REQUIRED_NODE_MAJOR=18

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must be run with sudo/root privileges."
  echo "Try: sudo bash deploy/install.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

install_node_guidance() {
  cat <<'EOF'
Node.js 18+ is required.
To install it manually on Debian/Raspberry Pi OS, you can use NodeSource:
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
EOF
}

node_major_version() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node_major_version)"
    if [ "${NODE_MAJOR}" -ge "${REQUIRED_NODE_MAJOR}" ]; then
      return 0
    fi
    echo "Found Node.js $(node -v), but Node.js ${REQUIRED_NODE_MAJOR}+ is required."
  else
    echo "Node.js was not found."
  fi

  if command -v apt-get >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    echo "Installing Node.js ${REQUIRED_NODE_MAJOR}.x using NodeSource..."
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  else
    install_node_guidance
    exit 1
  fi

  NODE_MAJOR="$(node_major_version)"
  if [ "${NODE_MAJOR}" -lt "${REQUIRED_NODE_MAJOR}" ]; then
    echo "Node.js installation did not provide Node.js ${REQUIRED_NODE_MAJOR}+."
    install_node_guidance
    exit 1
  fi
}

copy_project() {
  echo "Copying project from ${REPO_DIR} to ${APP_DIR}..."
  mkdir -p "${APP_DIR}"

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git' \
      --exclude 'node_modules' \
      "${REPO_DIR}/" "${APP_DIR}/"
  else
    find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    (
      cd "${REPO_DIR}"
      tar --exclude='./.git' --exclude='./node_modules' -cf - .
    ) | (
      cd "${APP_DIR}"
      tar -xf -
    )
  fi
}

install_service() {
  echo "Installing dependencies..."
  cd "${APP_DIR}"
  npm install --omit=dev

  echo "Installing systemd service..."
  install -m 0644 "${APP_DIR}/deploy/${SERVICE_FILE}" "${SYSTEMD_DIR}/${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
}

print_summary() {
  HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "${HOST_IP}" ]; then
    URL="http://${HOST_IP}:3000"
  else
    URL="http://<raspberry-pi-ip>:3000"
  fi

  cat <<EOF

WiFi Performance Meter is installed and running.
Open: ${URL}

Check status:
  systemctl status ${SERVICE_NAME}

Follow logs:
  journalctl -u ${SERVICE_NAME} -f

If your system does not have a 'pi' user, edit ${SYSTEMD_DIR}/${SERVICE_FILE} and change User=pi.
EOF
}

ensure_node
copy_project
install_service
print_summary
