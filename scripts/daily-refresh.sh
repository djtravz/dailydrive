#!/bin/bash
# =============================================================================
# Daily Drive — Full Daily Refresh
# =============================================================================
# Runs once per day (e.g., 4:00 AM via cron).
# - Fetches fresh music (top tracks + genre discovery) and podcasts
# - Saves the music selection to state.json for hourly runs to reuse
# - Cleans up log files older than 7 days
#
# Cron example:  0 4 * * * /opt/dailydrive/scripts/daily-refresh.sh
# =============================================================================

set -euo pipefail

DAILYDRIVE_DIR="/opt/dailydrive"
LOG_DIR="${DAILYDRIVE_DIR}/logs"
LOG_FILE="${LOG_DIR}/dailydrive-$(date +%Y%m%d).log"

# Make sure log directory exists
mkdir -p "${LOG_DIR}"

# --- Log cleanup: delete log files older than 7 days ---
find "${LOG_DIR}" -name "dailydrive-*.log" -type f -mtime +7 -delete

# --- Auto-deploy: pull latest code from git and sync to /opt ---
GIT_REPO="/home/pdeglon/patdeg/dailydrive"
if [ -d "${GIT_REPO}/.git" ]; then
  echo "=== Auto-deploy: pulling latest code ===" >> "${LOG_FILE}"
  git -C "${GIT_REPO}" pull --ff-only >> "${LOG_FILE}" 2>&1 || echo "⚠️  Git pull failed (non-fatal, continuing with current code)" >> "${LOG_FILE}"
  # Sync code + config to /opt/dailydrive (skip tokens, state, node_modules)
  cp "${GIT_REPO}/index.js" "${DAILYDRIVE_DIR}/index.js"
  cp "${GIT_REPO}/setup.js" "${DAILYDRIVE_DIR}/setup.js"
  cp "${GIT_REPO}/taste-profile.js" "${DAILYDRIVE_DIR}/taste-profile.js"
  cp "${GIT_REPO}/package.json" "${DAILYDRIVE_DIR}/package.json"
  cp -r "${GIT_REPO}/scripts/"* "${DAILYDRIVE_DIR}/scripts/"
  # Config lives in git repo (gitignored) — always sync to /opt so changes take effect
  cp "${GIT_REPO}/config.yaml" "${DAILYDRIVE_DIR}/config.yaml"
  [ -f "${GIT_REPO}/.env" ] && cp "${GIT_REPO}/.env" "${DAILYDRIVE_DIR}/.env"
  echo "=== Auto-deploy complete ===" >> "${LOG_FILE}"
fi

# --- Run the full playlist refresh ---
echo "=== Daily full refresh started at $(date) ===" >> "${LOG_FILE}"
cd "${DAILYDRIVE_DIR}"
/usr/bin/node index.js >> "${LOG_FILE}" 2>&1
EXIT_CODE=$?
echo "=== Daily full refresh finished at $(date) (exit code: ${EXIT_CODE}) ===" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

exit ${EXIT_CODE}
