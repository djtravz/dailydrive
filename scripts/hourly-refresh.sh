#!/bin/bash
# =============================================================================
# Daily Drive — Hourly Podcast Refresh
# =============================================================================
# Runs every hour (e.g., :05 past each hour via cron).
# - Fetches only fresh podcast episodes (keeps music unchanged)
# - Reuses the music tracks saved by the daily full refresh
# - Skips entirely if no podcast episodes have changed since last run
#
# This keeps short-lived podcasts (like NPR News Now hourly bulletins)
# always available in your playlist without reshuffling your music.
#
# Cron example:  5 * * * * /opt/dailydrive/scripts/hourly-refresh.sh
# =============================================================================

set -euo pipefail

DAILYDRIVE_DIR="/opt/dailydrive"
LOG_DIR="${DAILYDRIVE_DIR}/logs"
LOG_FILE="${LOG_DIR}/dailydrive-$(date +%Y%m%d).log"

# Make sure log directory exists
mkdir -p "${LOG_DIR}"

# --- Run podcast-only refresh ---
echo "=== Hourly podcast refresh started at $(date) ===" >> "${LOG_FILE}"
cd "${DAILYDRIVE_DIR}"
/usr/bin/node index.js --podcast-only >> "${LOG_FILE}" 2>&1
EXIT_CODE=$?
echo "=== Hourly podcast refresh finished at $(date) (exit code: ${EXIT_CODE}) ===" >> "${LOG_FILE}"
echo "" >> "${LOG_FILE}"

exit ${EXIT_CODE}
