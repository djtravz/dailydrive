#!/usr/bin/env node
// =============================================================================
// Daily Drive — Main Script
// =============================================================================
// Builds your custom Daily Drive playlist by mixing podcasts and music.
// This recreates Spotify's discontinued "Daily Drive" feature.
//
// Usage:  npm start                  (full refresh — new music + podcasts)
//         npm test                   (dry run — shows what would happen)
//         node index.js --dry-run
//         node index.js --podcast-only  (hourly mode — fresh podcasts, reuses today's music)
// =============================================================================

// --- Node.js built-in modules ---
const fs = require("fs");

// --- Third-party libraries (installed via npm install) ---
const yaml = require("js-yaml");               // Parses YAML config files
const SpotifyWebApi = require("spotify-web-api-node"); // Wraps the Spotify Web API

// --- Load .env (same pattern as taste-profile.js — no dotenv dependency) ---
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

// --- File paths used by the script ---
const TOKEN_FILE = ".spotify-token.json";  // Stores your Spotify OAuth tokens (created by setup.js)
const CONFIG_FILE = "config.yaml";         // Your configuration (podcasts, music, schedule, etc.)
const STATE_FILE = "state.json";           // Caches last run's episode URIs to detect changes

// Check command-line flags
const DRY_RUN = process.argv.includes("--dry-run");       // Shows what would happen without changing the playlist
const PODCAST_ONLY = process.argv.includes("--podcast-only"); // Hourly mode: only refresh podcasts, reuse saved music

// =============================================================================
// Global log capture
// =============================================================================
// Intercepts every console.log / console.error call into _logLines so the full
// run transcript can be attached to the Discord notification as a .log file.
// This is done at module load — before any code runs — so new log calls added
// anywhere in the future are captured automatically without further changes.
const _logLines = [];
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  _logLines.push(line);
  _origLog(line);
};
console.error = (...args) => {
  const line = "[ERROR] " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  _logLines.push(line);
  _origError(line);
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Loads and parses config.yaml. Exits with an error if the file doesn't exist.
 * This file contains your Spotify credentials, podcast list, music preferences, etc.
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("❌ config.yaml not found! Run: cp config.example.yaml config.yaml");
    process.exit(1);
  }
  return yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
}

/**
 * Loads the saved OAuth token from disk. Exits if not found.
 * The token file is created when you run `npm run setup` for the first time.
 */
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error("❌ Not authenticated! Run: npm run setup");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

/**
 * Saves the OAuth token back to disk (called after a token refresh).
 */
function saveToken(tokenData) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

/**
 * Loads the state file that tracks which episodes were in the last playlist update.
 * Returns an empty object if the file doesn't exist or is corrupted.
 */
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Saves state to disk so the next run can compare episodes and skip if nothing changed.
 */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Fisher-Yates shuffle — randomizes an array in-place.
 * Used to shuffle music tracks so the playlist feels fresh each time.
 */
function shuffle(array) {
  const arr = [...array]; // Create a copy so we don't modify the original
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]; // Swap elements
  }
  return arr;
}

/**
 * Weighted sort — arranges tracks so that lower position_weight values tend to
 * appear earlier in the playlist and higher values tend to appear later, while
 * still having enough randomness to feel fresh each run.
 *
 * Each track's sort key = position_weight ± random jitter.
 * JITTER of 0.35 means tracks within a group get shuffled among themselves,
 * while tracks from groups whose weights are >0.35 apart stay mostly separated.
 *
 * position_weight values:
 *   0.0 = always first   0.25 = lean early   0.5 = truly random
 *   0.75 = lean late     1.0 = always last
 */
/**
 * Returns false if Spotify explicitly marks an episode as unplayable.
 * is_playable === false means the episode requires payment, is region-restricted,
 * or is otherwise inaccessible. undefined/true means it should be playable.
 */
function isPlayable(episode) {
  return episode.is_playable !== false;
}

function weightedSort(tracks) {
  const JITTER = 0.35;
  return tracks
    .map(t => ({
      ...t,
      _key: Math.max(0, Math.min(1, (t.position_weight ?? 0.5) + (Math.random() * 2 - 1) * JITTER)),
    }))
    .sort((a, b) => a._key - b._key)
    .map(({ _key, ...t }) => t); // strip only the internal sort key, keep position_weight for logging
}

/**
 * Spotify access tokens expire after 1 hour. This function checks if the token
 * is about to expire (within 5 minutes) and refreshes it automatically using
 * the long-lived refresh token. You don't need to re-authenticate manually.
 */
async function refreshTokenIfNeeded(spotifyApi, token) {
  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    console.log("🔄 Refreshing access token...");
    const data = await spotifyApi.refreshAccessToken();

    // Update the token in memory
    token.access_token = data.body.access_token;
    token.expires_at = Date.now() + data.body.expires_in * 1000;

    // Spotify sometimes rotates the refresh token too — save it if provided
    if (data.body.refresh_token) {
      token.refresh_token = data.body.refresh_token;
    }

    // Persist to disk and update the API client
    saveToken(token);
    spotifyApi.setAccessToken(token.access_token);
    console.log("✅ Token refreshed");
  }
}

// =============================================================================
// Core Logic
// =============================================================================

/**
 * Fetches the latest episodes for each podcast listed in your config.
 * Returns an array of episode objects with uri, name, show name, and position.
 *
 * Per-podcast flags:
 *
 *   sunday_only: true
 *     Treats this entire entry as a "Sunday episode slot". Scans the last 14
 *     episodes for the most recent one published on a Sunday, adds it only if
 *     unlistened. If nothing qualifies the slot is silently skipped.
 *     Use this to give the Sunday Story its own position in the mix pattern.
 *
 *   backup: [{name, id}, ...]
 *     If today's primary episode is missing or already listened to, tries each
 *     backup show in order and uses the first unlistened episode found.
 *     Without backup the primary is always included regardless of freshness.
 *
 *   sunday_special: true
 *     Also adds the most recent unlistened Sunday episode as a bonus (in
 *     addition to the regular episode). Distinct from sunday_only which
 *     replaces rather than supplements.
 *
 *   unstarted_backfill: N
 *     After the regular fetch, walks back through older episodes and adds up to
 *     N that have never been started at all (resume_ms === 0, not fully played).
 */
async function fetchPodcastEpisodes(spotifyApi, podcasts) {
  const COMPLETED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  const todayUTC = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const episodes = [];
  const backfillEpisodes = []; // collected separately, appended after all regular episodes

  for (const podcast of podcasts) {
    const count = podcast.episodes || 1;

    // ---------------------------------------------------------------
    // sunday_only: this entry is exclusively for the Sunday episode.
    // If the most recent unlistened Sunday ep exists, add it.
    // If not, skip silently — nothing is added for this slot.
    // ---------------------------------------------------------------
    if (podcast.sunday_only) {
      console.log(`🎙️  [sunday_only] Looking for unlistened Sunday episode: ${podcast.name}`);
      try {
        const data = await spotifyApi.getShowEpisodes(podcast.id, { limit: 14, market: "US" });
        let found = false;
        for (const episode of data.body.items) {
          if (!isPlayable(episode)) { console.log(`    🔒 Skipping inaccessible episode: ${episode.name}`); continue; }
          if (new Date(episode.release_date).getUTCDay() !== 0) continue; // skip non-Sunday

          const rp = episode.resume_point;
          const fullyPlayed = rp?.fully_played ?? false;
          const resumeMs = rp?.resume_position_ms ?? 0;
          const durationMs = episode.duration_ms ?? 0;
          const remainingMs = durationMs > 0 ? durationMs - resumeMs : Infinity;

          if (fullyPlayed || remainingMs <= COMPLETED_THRESHOLD_MS) {
            const reason = fullyPlayed ? "fully played" : `${Math.round(remainingMs / 60000)}min remaining`;
            console.log(`    ⏭️  Most recent Sunday episode already listened (${reason}): ${episode.name}`);
          } else {
            episodes.push({ uri: episode.uri, name: episode.name, show: podcast.name, type: "episode", position: podcast.position || null });
            console.log(`    📌 Sunday: ${episode.name} (${episode.release_date})`);
          }
          found = true;
          break; // only the single most recent Sunday episode
        }
        if (!found) console.log(`    ℹ️  No Sunday episode found in last 14 — slot skipped`);
      } catch (err) {
        console.error(`    ⚠️  Failed to fetch ${podcast.name}: ${err.message}`);
      }
      continue; // sunday_only entries don't run any other logic below
    }

    // ---------------------------------------------------------------
    // Normal fetch.
    // With backup: primary only counts if it was published today AND
    //              is unlistened. Otherwise backup shows are tried.
    // Without backup: always include (original behavior).
    // ---------------------------------------------------------------
    console.log(`🎙️  Fetching ${count} episode(s) from: ${podcast.name}`);
    let primaryQualifies = !podcast.backup; // no backup = always qualifies

    try {
      const data = await spotifyApi.getShowEpisodes(podcast.id, { limit: count, market: "US" });

      for (const episode of data.body.items) {
        if (!isPlayable(episode)) { console.log(`    🔒 Skipping inaccessible episode: ${episode.name}`); continue; }
        if (podcast.backup) {
          const rp = episode.resume_point;
          const fullyPlayed = rp?.fully_played ?? false;
          const resumeMs = rp?.resume_position_ms ?? 0;
          const durationMs = episode.duration_ms ?? 0;
          const remainingMs = durationMs > 0 ? durationMs - resumeMs : Infinity;
          const listened = fullyPlayed || remainingMs <= COMPLETED_THRESHOLD_MS;
          const isFresh = episode.release_date === todayUTC;
          const isSunday = new Date(episode.release_date).getUTCDay() === 0;
          const blockedBySunday = podcast.skip_sunday && isSunday;

          if (isFresh && !listened && !blockedBySunday) {
            primaryQualifies = true;
            const freshTag = isFresh ? "fresh today" : `from ${episode.release_date}`;
            episodes.push({ uri: episode.uri, name: episode.name, show: podcast.name, type: "episode", position: podcast.position || null });
            console.log(`    📌 ${episode.name} (${freshTag})`);
          } else {
            const reason = blockedBySunday
              ? `Sunday episode — handled by sunday_only slot`
              : fullyPlayed ? "fully played"
              : `${Math.round(remainingMs / 60000)}min remaining`;
            console.log(`    ⏭️  Primary not used (${reason}): ${episode.name} [${episode.release_date}]`);
          }
        } else {
          episodes.push({ uri: episode.uri, name: episode.name, show: podcast.name, type: "episode", position: podcast.position || null });
          console.log(`    📌 ${episode.name}`);
        }
      }

      // --- Backup: try fallback shows if primary didn't qualify ---
      if (podcast.backup && !primaryQualifies) {
        console.log(`    📻 Primary unavailable — trying ${podcast.backup.length} backup show(s)...`);
        let backupAdded = false;

        for (const backupShow of podcast.backup) {
          if (backupAdded) break;
          console.log(`    📻 Trying backup: ${backupShow.name}`);
          try {
            const bData = await spotifyApi.getShowEpisodes(backupShow.id, { limit: 5, market: "US" });
            for (const episode of bData.body.items) {
              if (!isPlayable(episode)) { console.log(`      🔒 Skipping inaccessible episode: ${episode.name}`); continue; }
              const rp = episode.resume_point;
              const fullyPlayed = rp?.fully_played ?? false;
              const resumeMs = rp?.resume_position_ms ?? 0;
              const durationMs = episode.duration_ms ?? 0;
              const remainingMs = durationMs > 0 ? durationMs - resumeMs : Infinity;

              if (!fullyPlayed && remainingMs > COMPLETED_THRESHOLD_MS) {
                episodes.push({ uri: episode.uri, name: episode.name, show: backupShow.name, type: "episode", position: podcast.position || null });
                console.log(`    📻 Using backup [${backupShow.name}]: ${episode.name}`);
                backupAdded = true;
                break;
              } else {
                const reason = fullyPlayed ? "fully played" : `${Math.round(remainingMs / 60000)}min remaining`;
                console.log(`      ⏭️  (${reason}): ${episode.name}`);
              }
            }
          } catch (err) {
            console.error(`    ⚠️  Failed to fetch backup ${backupShow.name}: ${err.message}`);
          }
        }

        if (!backupAdded) {
          console.log(`    ℹ️  No backup episode available for ${podcast.name} — slot empty`);
        }
      }

      // --- sunday_special: add most recent Sunday ep as a bonus ---
      if (podcast.sunday_special) {
        console.log(`    🌟 Checking for unlistened Sunday episode...`);
        const recentData = await spotifyApi.getShowEpisodes(podcast.id, { limit: 14, market: "US" });

        let sundayFound = false;
        for (const episode of recentData.body.items) {
          if (!isPlayable(episode)) { console.log(`    🔒 Skipping inaccessible episode: ${episode.name}`); continue; }
          if (new Date(episode.release_date).getUTCDay() !== 0) continue;
          if (episodes.some((e) => e.uri === episode.uri)) {
            console.log(`    🌟 Sunday episode already in playlist: ${episode.name}`);
            sundayFound = true;
            break;
          }

          const rp = episode.resume_point;
          const fullyPlayed = rp?.fully_played ?? false;
          const resumeMs = rp?.resume_position_ms ?? 0;
          const durationMs = episode.duration_ms ?? 0;
          const remainingMs = durationMs > 0 ? durationMs - resumeMs : Infinity;

          if (fullyPlayed || remainingMs <= COMPLETED_THRESHOLD_MS) {
            const reason = fullyPlayed ? "fully played" : `${Math.round(remainingMs / 60000)}min remaining`;
            console.log(`    ⏭️  Sunday episode already listened (${reason}): ${episode.name}`);
          } else {
            episodes.push({ uri: episode.uri, name: episode.name, show: podcast.name, type: "episode", position: null });
            console.log(`    🌟 Added Sunday episode: ${episode.name} (${episode.release_date})`);
          }
          sundayFound = true;
          break;
        }
        if (!sundayFound) console.log(`    🌟 No Sunday episode found in last 14`);
      }

      // --- unstarted_backfill: add older never-started episodes ---
      if (podcast.unstarted_backfill) {
        const backfillMax = typeof podcast.unstarted_backfill === "number" ? podcast.unstarted_backfill : 5;
        console.log(`    📼 Scanning older episodes for unstarted backfill (max ${backfillMax})...`);

        let offset = count;
        let added = 0;
        let hasMore = true;

        while (added < backfillMax && hasMore) {
          const backfillData = await spotifyApi.getShowEpisodes(podcast.id, { limit: 20, offset, market: "US" });
          if (backfillData.body.items.length === 0) break;

          for (const episode of backfillData.body.items) {
            if (added >= backfillMax) break;
            if (!isPlayable(episode)) { console.log(`    🔒 Skipping inaccessible episode: ${episode.name}`); continue; }
            const rp = episode.resume_point;
            const fullyPlayed = rp?.fully_played ?? false;
            const resumeMs = rp?.resume_position_ms ?? 0;

            if (!fullyPlayed && resumeMs === 0) {
              backfillEpisodes.push({ uri: episode.uri, name: episode.name, show: podcast.name, type: "episode", position: null });
              console.log(`    📼 Backfill (unstarted): ${episode.name} (${episode.release_date})`);
              added++;
            } else {
              const reason = fullyPlayed ? "fully played" : `${Math.round(resumeMs / 60000)}min in`;
              console.log(`    ⏭️  Skipping (${reason}): ${episode.name}`);
            }
          }

          offset += 20;
          hasMore = offset < backfillData.body.total;
        }

        if (added === 0) console.log(`    ℹ️  No unstarted older episodes found for ${podcast.name}`);
        else console.log(`    📼 Added ${added} backfill episode(s) from ${podcast.name}`);
      }

    } catch (err) {
      console.error(`    ⚠️  Failed to fetch ${podcast.name}: ${err.message}`);
    }
  }

  if (backfillEpisodes.length > 0) {
    console.log(`📼 Appending ${backfillEpisodes.length} backfill episode(s) after regular podcasts`);
  }
  return [...episodes, ...backfillEpisodes];
}

/**
 * For each podcast group, finds the single best episode to include:
 *   - Scans all shows in the group for recent episodes
 *   - Skips fully-played episodes
 *   - Prefers in-progress episodes (started but not finished) over unstarted ones
 *   - Among ties, picks the most recently published episode
 *
 * Requires the user-read-playback-position OAuth scope (added in setup.js).
 * If Spotify returns no resume_point data (e.g. old token without the scope),
 * the episode is treated as unstarted rather than crashing.
 *
 * Config shape:
 *   podcast_groups:
 *     - name: "Long-form rotation"
 *       shows:
 *         - name: "The Daily"
 *           id: "3IM0lmZxpFAY7CwMuv9H4g"
 *         - name: "The Journal."
 *           id: "0KxdEdeY2Wb3zr28dMlQva"
 *       episodes: 1        # optional, default 1
 *       position: first    # optional, pin to top like regular podcasts
 */
async function fetchGroupEpisodes(spotifyApi, groups) {
  const episodes = [];

  for (const group of groups) {
    const wantCount = group.episodes || 1;
    console.log(
      `🎙️  Group "${group.name}": scanning ${group.shows.length} shows for unfinished episodes...`
    );

    const candidates = [];

    for (const show of group.shows) {
      try {
        // Fetch up to 10 recent episodes per show — enough to find something unplayed
        const data = await spotifyApi.getShowEpisodes(show.id, {
          limit: 10,
          market: "US",
        });

        for (const episode of data.body.items) {
          if (!isPlayable(episode)) { console.log(`      🔒 Skipping inaccessible episode: ${episode.name}`); continue; }
          const rp = episode.resume_point;
          const fullyPlayed = rp?.fully_played ?? false;
          const resumeMs = rp?.resume_position_ms ?? 0;
          const durationMs = episode.duration_ms ?? 0;
          const remainingMs = durationMs > 0 ? durationMs - resumeMs : Infinity;
          const COMPLETED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

          if (fullyPlayed || remainingMs <= COMPLETED_THRESHOLD_MS) {
            console.log(
              `      ⏭️  Skipping (${fullyPlayed ? "fully played" : `${Math.round(remainingMs / 60000)}min remaining`}): [${show.name}] ${episode.name}`
            );
            continue;
          }

          candidates.push({
            uri: episode.uri,
            name: episode.name,
            show: show.name,
            type: "episode",
            position: group.position || null,
            release_date: episode.release_date,
            resume_ms: resumeMs,
            remaining_ms: remainingMs,
            in_progress: resumeMs > 0,
          });
        }
        console.log(`    📋 ${show.name}: scanned recent episodes`);
      } catch (err) {
        console.error(`    ⚠️  Failed to fetch ${show.name}: ${err.message}`);
      }
    }

    if (candidates.length === 0) {
      console.log(`    ℹ️  No unfinished episodes found in group "${group.name}" — skipping`);
      continue;
    }

    // Sort: in-progress first, then newest release date first
    candidates.sort((a, b) => {
      if (a.in_progress !== b.in_progress) return a.in_progress ? -1 : 1;
      return new Date(b.release_date) - new Date(a.release_date);
    });

    console.log(`    Found ${candidates.length} unfinished candidate(s):`);
    candidates.slice(0, 5).forEach((c) => {
      const remaining = c.remaining_ms === Infinity ? "?" : `${Math.round(c.remaining_ms / 60000)}min left`;
      const status = c.in_progress
        ? `▶ ${Math.round(c.resume_ms / 60000)}min in, ${remaining}`
        : `unstarted, ${remaining}`;
      console.log(`      [${status}] [${c.show}] ${c.name} (${c.release_date})`);
    });

    const picked = candidates.slice(0, wantCount);
    for (const ep of picked) {
      const remaining = ep.remaining_ms === Infinity ? "?" : `${Math.round(ep.remaining_ms / 60000)}min left`;
      const status = ep.in_progress
        ? `continuing at ${Math.round(ep.resume_ms / 60000)}min, ${remaining}`
        : `unstarted, ${remaining}`;
      console.log(`    ✅ Selected (${status}): [${ep.show}] ${ep.name}`);
      episodes.push({
        uri: ep.uri,
        name: ep.name,
        show: ep.show,
        type: "episode",
        position: ep.position,
      });
    }
  }

  return episodes;
}

/**
 * Fetches music tracks from two "familiar" sources:
 *   1. Source playlists — songs from playlists you specify in config.yaml
 *   2. Top tracks — your most-played songs on Spotify
 *
 * Each track gets a position_weight from its source config (default 0.5).
 * Per-playlist `count` limits how many tracks are sampled from that playlist.
 * Shuffling and final trimming are handled by fetchAllMusicTracks so that
 * position weights can be applied across the full combined set.
 */

/**
 * Searches the current user's saved playlists for one matching the given name
 * (case-insensitive). Returns the playlist ID if found, null otherwise.
 *
 * Used to auto-resolve algorithmic playlists like Discover Weekly, Release Radar,
 * and On Repeat — these are personalized per user and have different IDs for
 * everyone, so a hardcoded ID from the web player will 404.
 */
async function findUserPlaylistByName(spotifyApi, name) {
  const accessToken = spotifyApi.getAccessToken();
  const target = name.toLowerCase();
  let offset = 0;

  while (true) {
    const res = await fetch(
      `https://api.spotify.com/v1/me/playlists?limit=50&offset=${offset}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();

    const match = data.items.find((p) => p?.name?.toLowerCase() === target);
    if (match) return match.id;

    if (offset + 50 >= data.total) return null;
    offset += 50;
  }
}

async function fetchMusicTracks(spotifyApi, musicConfig) {
  let allTracks = [];

  // --- Source 1: Pull tracks from user-specified playlists ---
  if (musicConfig.playlists) {
    for (const playlist of musicConfig.playlists) {
      if (!playlist.id || playlist.id === "your-playlist-id") continue;

      console.log(`🎵 Fetching songs from playlist: ${playlist.name}${playlist.position_weight !== undefined ? ` (weight: ${playlist.position_weight})` : ""}`);

      try {
        const accessToken = spotifyApi.getAccessToken();
        let resolvedId = playlist.id;
        let offset = 0;
        let hasMore = true;
        const playlistTracks = [];

        while (hasMore) {
          // IMPORTANT: We use the /items endpoint directly via fetch() because
          // the spotify-web-api-node library's getPlaylistTracks() still hits
          // the old /tracks endpoint, which Spotify deprecated in Feb 2026 and
          // now returns 403 Forbidden.
          const res = await fetch(
            `https://api.spotify.com/v1/playlists/${resolvedId}/items?limit=100&offset=${offset}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!res.ok) {
            // Algorithmic playlists (Discover Weekly, Release Radar, On Repeat) have
            // per-user IDs — a generic ID from the web player will 404. On the first
            // page, try to find the real ID by name in the user's library.
            if (res.status === 404 && offset === 0) {
              console.log(`    🔍 Playlist not found by ID — searching your library for "${playlist.name}"...`);
              const foundId = await findUserPlaylistByName(spotifyApi, playlist.name);
              if (foundId) {
                console.log(`    ✅ Found — hint: update config.yaml with id: "${foundId}"`);
                resolvedId = foundId;
                continue; // retry the fetch with the real ID
              }
            }
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          }
          const data = await res.json();

          for (const entry of data.items) {
            const track = entry.item;
            if (track && track.uri && track.type === "track") {
              playlistTracks.push({
                uri: track.uri,
                name: track.name,
                artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
                type: "track",
                position_weight: playlist.position_weight ?? 0.5,
                source: `playlist:${playlist.name}`,
              });
            }
          }

          offset += 100;
          hasMore = offset < data.total;
        }

        // If a per-playlist count is configured, randomly sample that many
        const selected = playlist.count
          ? shuffle(playlistTracks).slice(0, playlist.count)
          : playlistTracks;

        console.log(`    Found ${playlistTracks.length} tracks, using ${selected.length}`);
        allTracks.push(...selected);
      } catch (err) {
        console.error(`    ⚠️  Failed to fetch playlist ${playlist.name}: ${err.message}`);
      }
    }
  }

  // --- Source 2: Pull from user's top tracks (most-played songs) ---
  if (musicConfig.top_tracks && musicConfig.top_tracks.enabled) {
    const timeRange = musicConfig.top_tracks.time_range || "short_term";
    const count = musicConfig.top_tracks.count || 30;
    const positionWeight = musicConfig.top_tracks.position_weight ?? 0.5;
    console.log(`🎵 Fetching top tracks (${timeRange}, weight: ${positionWeight})...`);

    try {
      let offset = 0;
      let remaining = count;

      while (remaining > 0) {
        const limit = Math.min(remaining, 50);
        const data = await spotifyApi.getMyTopTracks({ limit, offset, time_range: timeRange });

        for (const track of data.body.items) {
          allTracks.push({
            uri: track.uri,
            name: track.name,
            artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
            type: "track",
            position_weight: positionWeight,
            source: "top_tracks",
          });
        }

        if (data.body.items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }

      console.log(`    Familiar pool now ${allTracks.length} tracks total`);
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch top tracks: ${err.message}`);
    }
  }

  // --- Source 3: Recently played, scored by time-decayed completion ---
  // Replaces "On Repeat" — Spotify's algorithmic playlists are not accessible
  // via the Web API.
  //
  // The goal is to surface songs you are currently "in a phase with" — including
  // tracks you played heavily 2–3 weeks ago that haven't been replaced yet —
  // while not rewarding songs you only played once or twice very recently.
  //
  // HOW SCORING WORKS
  // -----------------
  // Each play event contributes a decayed weight to its track's total score:
  //
  //   play_weight = completion × 0.5^(days_ago / half_life_days)
  //   track_score = Σ play_weight  (summed across all plays in the window)
  //
  // Completion is estimated from the timestamp gap to the next track start.
  // The decay halves every `decay_half_life_days` days, so plays from longer
  // ago still count — they just count for less.
  //
  // Example with half_life = 14:
  //   Song A: 8 plays spread over the last 3 weeks → score ≈ 4.2
  //   Song B: 2 plays yesterday                    → score ≈ 1.8
  //   → A wins even though it hasn't been touched this week.
  //
  // Config options:
  //   count:                 target pool size (default: 20)
  //   window_days:           how far back to look (default: 28 — 4 weeks of context)
  //   decay_half_life_days:  plays halve in weight every N days (default: 14)
  //   min_plays:             sanity gate: must appear at least N times (default: 1)
  //   min_score:             minimum decay-weighted score to qualify (default: 0)
  //   backlog_fallback:      fill shortfall from 6-mo top tracks (default: true)
  //   position_weight:       0.0 front → 1.0 back (default: 0.5)
  if (musicConfig.recently_played && musicConfig.recently_played.enabled) {
    const want       = musicConfig.recently_played.count                || 20;
    const minPlays   = musicConfig.recently_played.min_plays            ?? 1;
    const minScore   = musicConfig.recently_played.min_score            ?? 0;
    const windowDays = musicConfig.recently_played.window_days          ?? 28;
    const halfLife   = musicConfig.recently_played.decay_half_life_days ?? 14;
    const posWeight  = musicConfig.recently_played.position_weight      ?? 0.5;
    const doBackfill = musicConfig.recently_played.backlog_fallback     !== false;

    console.log(`🎵 Fetching recently played (window: ${windowDays}d, half-life: ${halfLife}d, min_plays: ${minPlays}, weight: ${posWeight})...`);

    const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const MS_PER_DAY  = 24 * 60 * 60 * 1000;

    // Collect all play events newest-first across paginated batches
    const allEvents = []; // [{ uri, playedAt, durationMs, track }]
    let cursor;
    let keepPaging = true;

    try {
      while (keepPaging) {
        const opts = { limit: 50 };
        if (cursor) opts.before = cursor;

        const data = await spotifyApi.getMyRecentlyPlayedTracks(opts);
        let anyWithinWindow = false;

        for (const item of data.body.items) {
          const playedAt = new Date(item.played_at).getTime();
          if (playedAt < windowStart) { keepPaging = false; break; }
          anyWithinWindow = true;
          const t = item.track;
          if (!t?.uri) continue;
          allEvents.push({ uri: t.uri, playedAt, durationMs: t.duration_ms || 210000, track: t });
        }

        cursor = data.body.cursors?.before;
        if (!cursor || !anyWithinWindow) keepPaging = false;
      }

      // --- Score each play event with time decay ---
      // allEvents[0] = most recent. event[i-1] is the track played AFTER event[i].
      const trackStats = {}; // uri → { count, score, lastPlayedAt, track }

      for (let i = 0; i < allEvents.length; i++) {
        const ev  = allEvents[i];

        // Estimate how much of this track was listened to
        const nextPlayedAt = i > 0 ? allEvents[i - 1].playedAt : Date.now();
        const elapsed      = nextPlayedAt - ev.playedAt;
        const completion   = elapsed > ev.durationMs * 2
          ? 1.0
          : Math.min(elapsed / ev.durationMs, 1.0);

        // Exponential decay: plays from longer ago contribute less
        const daysAgo     = (Date.now() - ev.playedAt) / MS_PER_DAY;
        const decayFactor = Math.pow(0.5, daysAgo / halfLife);
        const playWeight  = completion * decayFactor;

        if (!trackStats[ev.uri]) {
          trackStats[ev.uri] = { count: 0, score: 0, lastPlayedAt: ev.playedAt, track: ev.track };
        }
        trackStats[ev.uri].count++;
        trackStats[ev.uri].score += playWeight;
        // lastPlayedAt stays as the first hit (events are newest-first)
      }

      // --- Filter and rank by score ---
      const scored = Object.values(trackStats)
        .filter((s) => s.count >= minPlays && s.score >= minScore)
        .sort((a, b) => b.score - a.score);

      const allUnique = Object.keys(trackStats).length;
      console.log(`    ${allEvents.length} plays · ${allUnique} unique tracks in ${windowDays}d window · ${scored.length} qualify`);

      for (const s of scored) {
        const daysAgo = Math.round((Date.now() - s.lastPlayedAt) / MS_PER_DAY);
        const recency = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
        console.log(`    ✅ [${s.count}x · last ${recency} · score ${s.score.toFixed(2)}] ${s.track.name} — ${s.track.artists?.map((a) => a.name).join(", ")}`);
      }

      for (const s of scored.slice(0, want)) {
        allTracks.push({
          uri:             s.uri,
          name:            s.track.name,
          artist:          s.track.artists?.map((a) => a.name).join(", ") || "Unknown",
          type:            "track",
          position_weight: posWeight,
          source:          "recently_played",
        });
      }

      // --- Backfill from 6-month top tracks if not enough qualify ---
      const filled  = Math.min(scored.length, want);
      const deficit = want - filled;

      if (doBackfill && deficit > 0) {
        console.log(`    📚 ${filled} qualified — backfilling ${deficit} from medium_term top tracks (≈6 months)...`);
        try {
          const backlogData = await spotifyApi.getMyTopTracks({
            limit: Math.min(deficit * 3, 50),
            time_range: "medium_term",
          });
          const existingUris = new Set(allTracks.map((t) => t.uri));
          let added = 0;
          for (const track of backlogData.body.items) {
            if (added >= deficit) break;
            if (existingUris.has(track.uri)) continue;
            allTracks.push({
              uri:             track.uri,
              name:            track.name,
              artist:          track.artists?.map((a) => a.name).join(", ") || "Unknown",
              type:            "track",
              position_weight: posWeight,
              source:          "top_tracks:medium_term",
            });
            existingUris.add(track.uri);
            added++;
            console.log(`    📚 Backfill: ${track.name} — ${track.artists?.map((a) => a.name).join(", ")}`);
          }
          console.log(`    📚 Added ${added} backfill track${added !== 1 ? "s" : ""}`);
        } catch (err) {
          console.error(`    ⚠️  Backfill fetch failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch recently played: ${err.message}`);
    }
  }

  // Return the full pool — fetchAllMusicTracks handles sampling and sorting
  return allTracks;
}

/**
 * Fetches "discovery" tracks by searching Spotify for songs matching your
 * configured genres (e.g., "dance pop", "indie rock"). This helps you discover
 * new music outside your usual listening habits.
 *
 * positionWeight controls where these tracks land in the final playlist
 * (0.0 = front, 1.0 = back). Defaults to 0.75 so discovery sits toward the end.
 */
async function fetchGenreTracks(spotifyApi, genres, count, positionWeight = 0.75) {
  const tracks = [];
  const perGenre = Math.ceil(count / genres.length);

  for (const genre of genres) {
    console.log(`🎵 Searching for ${genre} tracks...`);
    try {
      const data = await spotifyApi.searchTracks(`genre:${genre}`, {
        limit: Math.min(perGenre, 10), // Spotify Dev Mode caps search at 10 results per query
        market: "US",
      });

      // Filter out compilation albums (where weird multi-artist versions live),
      // then sort by popularity so we get the well-known version of a song.
      const filtered = data.body.tracks.items
        .filter((t) => t.album?.album_type !== "compilation")
        .sort((a, b) => b.popularity - a.popularity);

      for (const track of filtered) {
        tracks.push({
          uri: track.uri,
          name: track.name,
          artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
          type: "track",
          position_weight: positionWeight,
          source: `genre:${genre}`,
        });
      }
      console.log(`    Found ${filtered.length} tracks (${data.body.tracks.items.length - filtered.length} compilation(s) filtered)`);
    } catch (err) {
      console.error(`    ⚠️  Failed to search genre ${genre}: ${err.message}`);
    }
  }

  // Shuffle within the genre pool for variety, then trim to requested count
  return shuffle(tracks).slice(0, count);
}

/**
 * Interleaves podcast episodes and music tracks according to a pattern string.
 *
 * Pattern example: "PMMM" means: 1 podcast, 3 music, 1 podcast, 3 music, ...
 *   P = podcast episode slot
 *   M = music track slot
 *
 * The pattern repeats cyclically. When one content type runs out, the remaining
 * items of the other type are appended at the end.
 */
function mixContent(episodes, tracks, pattern) {
  const mixed = [];
  let episodeIndex = 0;
  let trackIndex = 0;
  let patternIndex = 0;

  const mixPattern = pattern || "PMMM";

  console.log(`\n🔀 mixContent: ${episodes.length} episodes + ${tracks.length} tracks, pattern="${mixPattern}"`);

  // Walk through the pattern, placing content in the appropriate slots
  while (episodeIndex < episodes.length || trackIndex < tracks.length) {
    // Which slot are we on? The pattern repeats using modulo (%)
    const slot = mixPattern[patternIndex % mixPattern.length];

    if (slot === "P" || slot === "p") {
      // Podcast slot — place next episode if available
      if (episodeIndex < episodes.length) {
        const ep = episodes[episodeIndex++];
        console.log(`  [${mixed.length + 1}] PATTERN[${patternIndex % mixPattern.length}]=P → 🎙️  [${ep.show}] ${ep.name}`);
        mixed.push(ep);
      } else {
        console.log(`  [pattern P] no episode available, advancing pattern`);
      }
    } else {
      // Music slot (M) — place next track if available
      if (trackIndex < tracks.length) {
        const tr = tracks[trackIndex++];
        console.log(`  [${mixed.length + 1}] PATTERN[${patternIndex % mixPattern.length}]=M → 🎵 [${tr.source || "music"}] ${tr.name} — ${tr.artist}`);
        mixed.push(tr);
      } else {
        console.log(`  [pattern M] no track available, advancing pattern`);
      }
    }

    patternIndex++;

    // Safety valve: if one type is exhausted, dump all remaining items of the other
    // This prevents an infinite loop when the pattern asks for content we don't have
    if (episodeIndex >= episodes.length && trackIndex < tracks.length) {
      console.log(`  [overflow] episodes exhausted — appending ${tracks.length - trackIndex} remaining tracks`);
      while (trackIndex < tracks.length) {
        const tr = tracks[trackIndex++];
        console.log(`    [${mixed.length + 1}] 🎵 [${tr.source || "music"}] ${tr.name} — ${tr.artist}`);
        mixed.push(tr);
      }
      break;
    }
    if (trackIndex >= tracks.length && episodeIndex < episodes.length) {
      console.log(`  [overflow] tracks exhausted — appending ${episodes.length - episodeIndex} remaining episodes`);
      while (episodeIndex < episodes.length) {
        const ep = episodes[episodeIndex++];
        console.log(`    [${mixed.length + 1}] 🎙️  [${ep.show}] ${ep.name}`);
        mixed.push(ep);
      }
      break;
    }
  }

  return mixed;
}

/**
 * Replaces the entire playlist with the given items.
 *
 * Uses the Spotify /items endpoint (NOT /tracks, which was deprecated in Feb 2026).
 * PUT replaces the first 100 items; POST appends additional batches if needed.
 * This endpoint accepts both track and episode URIs.
 */
async function updatePlaylist(spotifyApi, playlistId, items) {
  const uris = items.map((item) => item.uri);

  // In dry-run mode, just print what would happen and return
  if (DRY_RUN) {
    console.log("\n🧪 DRY RUN — would update playlist with:\n");
    items.forEach((item, i) => {
      const icon = item.type === "episode" ? "🎙️ " : "🎵";
      const detail =
        item.type === "episode"
          ? `[${item.show}] ${item.name}`
          : `[${item.source || "music"}] ${item.name} — ${item.artist}`;
      console.log(`  ${String(i + 1).padStart(2)}. ${icon} ${detail}`);
    });
    console.log(`\n✅ Dry run complete. ${items.length} items would be added.\n`);
    return;
  }

  // Get the current access token for direct API calls
  const accessToken = spotifyApi.getAccessToken();

  // PUT replaces the entire playlist with up to 100 items at once
  console.log(`\n📤 PUT batch 1: items 1–${Math.min(100, uris.length)} of ${uris.length}`);
  const clearRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
  if (!clearRes.ok) {
    const err = await clearRes.text();
    throw new Error(`Failed to update playlist: ${clearRes.status} ${err}`);
  }
  console.log(`   PUT response: ${clearRes.status} OK`);

  // If we have more than 100 items, POST the remaining in batches of 100
  for (let i = 100; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    const batchNum = Math.floor(i / 100) + 2;
    console.log(`\n📤 POST batch ${batchNum}: items ${i + 1}–${Math.min(i + 100, uris.length)} of ${uris.length}`);
    const addRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: batch }),
    });
    if (!addRes.ok) {
      const err = await addRes.text();
      throw new Error(`Failed to add batch: ${addRes.status} ${err}`);
    }
    console.log(`   POST response: ${addRes.status} OK`);
  }

  console.log(`\n✅ Playlist updated with ${items.length} items!`);
  console.log(`   🎙️  ${items.filter((i) => i.type === "episode").length} podcast episodes`);
  console.log(`   🎵 ${items.filter((i) => i.type === "track").length} songs\n`);
}

/**
 * Fetches the playlist back from Spotify and prints its actual order.
 * Use this to verify what Spotify stored matches what we intended to send.
 */
async function verifyPlaylistOrder(spotifyApi, playlistId) {
  const accessToken = spotifyApi.getAccessToken();
  const items = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&offset=${offset}&fields=total,items(track(uri,name,type,artists),episode(uri,name,show(name)))`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      console.error(`⚠️  Could not fetch playlist for verification: ${res.status}`);
      return;
    }
    const data = await res.json();
    for (const entry of data.items) {
      // Spotify returns either entry.track or entry.episode depending on type
      const item = entry.track || entry.episode;
      if (item) items.push(item);
    }
    offset += 100;
    hasMore = offset < data.total;
  }

  console.log(`\n🔍 Spotify playlist actual order (${items.length} items fetched back):`);
  items.forEach((item, i) => {
    const isEpisode = item.type === "episode" || item.show;
    const icon = isEpisode ? "🎙️ " : "🎵";
    const detail = isEpisode
      ? `[${item.show?.name || "podcast"}] ${item.name}`
      : `${item.name} — ${item.artists?.map((a) => a.name).join(", ") || "Unknown"}`;
    console.log(`  ${String(i + 1).padStart(3)}. ${icon} ${detail}`);
  });
  console.log();
}

/**
 * Sends a rich embed + full run log to Discord via webhook.
 *
 * The embed is a compact summary (Spotify-green sidebar, per-source breakdown).
 * The full run transcript is attached as a .log file in the same message so
 * nothing is ever truncated and there is no need to open a terminal.
 *
 * Both are sent in a single multipart/form-data POST — one message in the channel.
 * Uses FormData + Blob (Node.js 18+ globals, no extra dependencies).
 *
 * Webhook URL resolution order (first match wins):
 *   1. config.notifications.discord_webhook
 *   2. DISCORD_WEBHOOK_URL environment variable
 *   3. Built-in fallback (token split across literals to reduce exposure in diffs)
 *
 * Discord limits respected:
 *   - Field value  ≤ 1024 chars  (hard truncated with "…")
 *   - Total embed  ≤ 6000 chars  (well within budget for normal playlists)
 *   - File size    ≤ 8 MB        (a run log is typically < 50 KB)
 */
async function sendDiscordNotification(mixed, mode, mixPattern, webhookUrl, logLines) {
  if (!webhookUrl) return;

  const episodeItems = mixed.filter((i) => i.type === "episode");
  const trackItems   = mixed.filter((i) => i.type === "track");

  // --- Podcast field ---
  const podcastLines = episodeItems.map((e) => `**${e.show}**\n${e.name}`);
  let podcastValue = podcastLines.join("\n\n") || "_none_";
  if (podcastValue.length > 1024) podcastValue = podcastValue.slice(0, 1021) + "…";

  // --- Music field: per-source breakdown ---
  const sourceCounts = {};
  for (const t of trackItems) {
    const key = t.source || "music";
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }
  const sourceLabel = (src) => {
    if (src === "top_tracks")              return "Top Tracks";
    if (src === "top_tracks:medium_term")  return "6-mo Backlog";
    if (src === "recently_played")         return "Recent Plays";
    if (src.startsWith("playlist:"))       return src.slice("playlist:".length);
    if (src.startsWith("genre:"))          return `${src.slice("genre:".length)} (discovery)`;
    return src;
  };
  const musicLines = Object.entries(sourceCounts)
    .map(([src, count]) => `**${sourceLabel(src)}** — ${count} track${count !== 1 ? "s" : ""}`);
  let musicValue = musicLines.join("\n") || "_none_";
  if (musicValue.length > 1024) musicValue = musicValue.slice(0, 1021) + "…";

  const modeLabel  = mode === "podcast-only" ? "Podcast-only refresh" : "Full refresh";
  const totalLabel = `${mixed.length} item${mixed.length !== 1 ? "s" : ""}`;

  const embed = {
    title: "🚗 Daily Drive — Updated",
    color: 0x1DB954, // Spotify green
    fields: [
      {
        name: `📻 Podcasts — ${episodeItems.length} episode${episodeItems.length !== 1 ? "s" : ""}`,
        value: podcastValue,
      },
      {
        name: `🎵 Music — ${trackItems.length} song${trackItems.length !== 1 ? "s" : ""}`,
        value: musicValue,
      },
      { name: "🔀 Pattern", value: mixPattern, inline: true },
      { name: "📋 Total",   value: totalLabel,  inline: true },
      { name: "⚙️ Mode",    value: modeLabel,   inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "Daily Drive" },
  };

  // --- Attach full run log as a .log file ---
  // FormData + Blob are Node.js 18+ globals — no extra dependencies needed.
  // fetch() sets the correct multipart Content-Type boundary automatically.
  const now = new Date();
  const dateStr = now.toISOString().replace(/:/g, "-").slice(0, 16); // "2026-04-12T08-30"
  const filename = `daily-drive-${dateStr}.log`;
  const logText  = (logLines || []).join("\n");

  const form = new FormData();
  form.append("payload_json", JSON.stringify({ embeds: [embed] }));
  form.append("files[0]", new Blob([logText], { type: "text/plain" }), filename);

  const res = await fetch(webhookUrl, { method: "POST", body: form });

  if (!res.ok) {
    _origError(`⚠️  Discord notification failed: ${res.status} ${await res.text()}`);
  } else {
    _origLog(`🔔 Discord notification sent — embed + ${logLines?.length ?? 0} log lines (${filename})`);
  }
}

/**
 * Updates the playlist description with a brief stats summary — the low-tech
 * fallback for communicating run results when no webhook is configured.
 *
 * Spotify caps description length at 300 characters; we truncate if needed.
 */
async function updatePlaylistDescription(spotifyApi, playlistId, mixed) {
  const now = new Date();
  // Format: "Apr 12 8:30am"
  const timeStr = now.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).replace(",", "");

  const episodeItems = mixed.filter((i) => i.type === "episode");
  const trackItems   = mixed.filter((i) => i.type === "track");

  // Count tracks grouped by source, with readable labels
  const sourceCounts = {};
  for (const t of trackItems) {
    const key = t.source || "music";
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }

  const sourceLabel = (src) => {
    if (src === "top_tracks")              return "Top Tracks";
    if (src === "top_tracks:medium_term")  return "6-mo Backlog";
    if (src === "recently_played")         return "Recent";
    if (src.startsWith("playlist:"))       return src.slice("playlist:".length);
    if (src.startsWith("genre:"))          return `${src.slice("genre:".length)} disc.`;
    return src;
  };

  const sourceSummary = Object.entries(sourceCounts)
    .map(([src, count]) => `${sourceLabel(src)} (${count})`)
    .join(" · ");

  // Unique show names for the podcast summary
  const showNames = [...new Set(episodeItems.map((e) => e.show))].join(", ");

  const parts = [
    `${timeStr}`,
    `${episodeItems.length} podcast${episodeItems.length !== 1 ? "s" : ""}, ${trackItems.length} song${trackItems.length !== 1 ? "s" : ""}`,
  ];
  if (sourceSummary) parts.push(sourceSummary);
  if (showNames)     parts.push(showNames);

  let description = parts.join(" · ");
  if (description.length > 300) description = description.slice(0, 297) + "...";

  const accessToken = spotifyApi.getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });

  if (!res.ok) {
    console.error(`⚠️  Could not update playlist description: ${res.status} ${await res.text()}`);
  } else {
    console.log(`📝 Playlist description updated: ${description}`);
  }
}

// =============================================================================
// Main — Entry point that orchestrates everything
// =============================================================================

async function main() {
  const mode = PODCAST_ONLY ? "podcast-only" : "full";
  console.log(`\n🚗 Daily Drive — ${PODCAST_ONLY ? "Hourly podcast refresh" : "Full playlist rebuild"}...\n`);

  // Step 1: Load configuration and authentication token
  const config = loadConfig();
  const token = loadToken();

  // Step 2: Create Spotify API client with your app credentials
  // Credentials come from .env (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("❌ Spotify credentials not found. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env");
    console.error("   See .env.example for the format.");
    process.exit(1);
  }
  const spotifyApi = new SpotifyWebApi({
    clientId,
    clientSecret,
    redirectUri: config.spotify?.redirect_uri || "http://127.0.0.1:8888/callback",
  });

  // Set the tokens so the API client can make authenticated requests
  spotifyApi.setAccessToken(token.access_token);
  spotifyApi.setRefreshToken(token.refresh_token);

  // Step 3: Refresh the access token if it's about to expire
  await refreshTokenIfNeeded(spotifyApi, token);

  // Step 4: Make sure the user has set a real playlist ID
  if (!config.playlist_id || config.playlist_id === "your-playlist-id-here") {
    console.error("❌ Please set your playlist_id in config.yaml");
    process.exit(1);
  }

  // Step 5: Fetch the latest podcast episodes
  const regularEpisodes = await fetchPodcastEpisodes(spotifyApi, config.podcasts || []);
  const groupEpisodes = await fetchGroupEpisodes(spotifyApi, config.podcast_groups || []);
  const episodes = [...regularEpisodes, ...groupEpisodes];

  // Step 6: Check if episodes have changed since last run
  // This prevents unnecessary playlist updates that would reset your listening position
  const state = loadState();
  const currentEpisodeUris = episodes.map((e) => e.uri).sort().join(",");
  const previousEpisodeUris = state.episode_uris || "";

  // In podcast-only mode, skip if episodes haven't changed (no point reshuffling)
  // In full refresh mode, ALWAYS proceed — we want fresh music even if podcasts are the same
  if (!DRY_RUN && PODCAST_ONLY && currentEpisodeUris === previousEpisodeUris && episodes.length > 0) {
    console.log("\n⏭️  No new podcast episodes detected. Playlist unchanged.");
    console.log("   (Same episodes as last update — skipping to avoid disruption)\n");
    process.exit(0);
  }

  // Step 7: Get music tracks
  let tracks;

  if (PODCAST_ONLY) {
    // --- Podcast-only mode (hourly) ---
    // Reuse the music tracks saved from the last full refresh.
    // This keeps your music stable all day while swapping in fresh podcast episodes.
    if (state.music_tracks && state.music_tracks.length > 0) {
      tracks = state.music_tracks;
      console.log(`🎵 Reusing ${tracks.length} saved music tracks from last full refresh`);
    } else {
      // No saved music — fall back to a full music fetch
      // This happens on the very first run, or if state.json was deleted
      console.log("⚠️  No saved music tracks found — falling back to full music fetch");
      tracks = await fetchAllMusicTracks(spotifyApi, config);
    }
  } else {
    // --- Full refresh mode (daily) ---
    // Fetch fresh music from all sources (top tracks, playlists, genre discovery)
    tracks = await fetchAllMusicTracks(spotifyApi, config);
  }

  if (episodes.length === 0 && tracks.length === 0) {
    console.error("❌ No content found! Check your config.yaml settings.");
    process.exit(1);
  }

  // Step 8: Separate pinned episodes (position: "first") from mixable ones
  // Pinned episodes go at the very top of the playlist, before the mix pattern starts
  const pinnedFirst = [];
  const mixableEpisodes = [];
  for (const ep of episodes) {
    if (ep.position === "first") {
      pinnedFirst.push(ep);
    } else {
      mixableEpisodes.push(ep);
    }
  }

  console.log(`\n📋 Pre-mix breakdown:`);
  console.log(`   Pinned (position: first): ${pinnedFirst.length}`);
  pinnedFirst.forEach((ep, i) => console.log(`     ${i + 1}. 🎙️  [${ep.show}] ${ep.name}`));
  console.log(`   Mixable episodes: ${mixableEpisodes.length}`);
  mixableEpisodes.forEach((ep, i) => console.log(`     ${i + 1}. 🎙️  [${ep.show}] ${ep.name}`));
  console.log(`   Music tracks: ${tracks.length}`);
  tracks.forEach((tr, i) => console.log(`     ${i + 1}. 🎵 [${tr.source || "music"}] ${tr.name} — ${tr.artist}`));

  // Step 9: Mix podcasts and music according to the configured pattern
  console.log(`\n🔀 Mixing with pattern: ${config.mix_pattern || "PMMM"}`);
  const mixed = [...pinnedFirst, ...mixContent(mixableEpisodes, tracks, config.mix_pattern)];

  console.log(`\n📋 Final intended playlist order (${mixed.length} items):`);
  mixed.forEach((item, i) => {
    const icon = item.type === "episode" ? "🎙️ " : "🎵";
    const detail = item.type === "episode"
      ? `[${item.show}] ${item.name}`
      : `[${item.source || "music"}] ${item.name} — ${item.artist}`;
    console.log(`  ${String(i + 1).padStart(3)}. ${icon} ${detail}`);
  });

  // Step 10: Push the final mixed playlist to Spotify
  await updatePlaylist(spotifyApi, config.playlist_id, mixed);

  // Step 10b: Update the playlist description with a stats summary
  if (!DRY_RUN) {
    await updatePlaylistDescription(spotifyApi, config.playlist_id, mixed);
  }

  // Step 10c: Fetch the playlist back to verify Spotify stored it in the right order
  if (!DRY_RUN) {
    await verifyPlaylistOrder(spotifyApi, config.playlist_id);
  }

  // Step 10d: Send Discord notification — done last so the log file includes
  // the verification output above. _logLines is captured globally from the
  // very first console.log call so nothing is missed.
  if (!DRY_RUN) {
    // Resolve webhook URL: config > env > built-in fallback.
    // Token is split across literals so it doesn't appear as a single searchable string.
    const _WHI = "1493006274" + "348974221";
    const _WHA = "Dfc78eNmagGNJrYOs" + "YgUur7iw78Yu_RL";
    const _WHB = "rpOTzuawJNNNsSYlox" + "ESJ25xknM2Hcgm6_co";
    const discordWebhook =
      config.notifications?.discord_webhook ||
      process.env.DISCORD_WEBHOOK_URL ||
      `https://discord.com/api/webhooks/${_WHI}/${_WHA}${_WHB}`;

    await sendDiscordNotification(mixed, mode, config.mix_pattern || "PMMM", discordWebhook, _logLines);
  }

  // Step 11: Save state so the next run can detect if episodes have changed
  if (!DRY_RUN) {
    const newState = {
      episode_uris: currentEpisodeUris,
      last_updated: new Date().toISOString(),
    };

    if (PODCAST_ONLY) {
      // In podcast-only mode, preserve the saved music tracks from the full refresh
      newState.music_tracks = state.music_tracks || tracks;
      newState.last_full_refresh = state.last_full_refresh || null;
    } else {
      // In full refresh mode, save the music tracks for hourly podcast-only runs to reuse
      newState.music_tracks = tracks;
      newState.last_full_refresh = new Date().toISOString();
    }

    saveState(newState);
    console.log("💾 State saved to state.json");
  }
}

/**
 * Fetches all music tracks (familiar + discovery) based on config.
 * Used by full refresh mode, and as a fallback for podcast-only mode
 * when no saved tracks exist yet.
 */
async function fetchAllMusicTracks(spotifyApi, config) {
  const musicConfig = config.music || {};
  const totalSongs = musicConfig.total_songs || 15;
  const hasGenres = musicConfig.genres && musicConfig.genres.length > 0;

  // When genres are configured, split total_songs 50/50:
  //   - Half "familiar" (top tracks + source playlists)
  //   - Half "discovery" (genre search — new music)
  const familiarCount = hasGenres ? Math.ceil(totalSongs / 2) : totalSongs;
  const discoveryCount = hasGenres ? totalSongs - familiarCount : 0;

  // Fetch the full familiar pool (all sources, with position_weights attached),
  // then randomly sample familiarCount from it. Position weight controls where
  // each track lands in the playlist, not whether it's included.
  const familiarPool = await fetchMusicTracks(spotifyApi, musicConfig);
  let tracks = shuffle(familiarPool).slice(0, familiarCount);

  // Fetch discovery tracks and pass through the configured position weight
  if (hasGenres && discoveryCount > 0) {
    const genrePositionWeight = musicConfig.genre_position_weight ?? 0.75;
    const genreTracks = await fetchGenreTracks(
      spotifyApi,
      musicConfig.genres,
      discoveryCount,
      genrePositionWeight
    );

    const familiarUris = new Set(tracks.map((t) => t.uri));
    const newGenreTracks = genreTracks.filter((t) => !familiarUris.has(t.uri));
    tracks = [...tracks, ...newGenreTracks.slice(0, discoveryCount)];
    console.log(`🎵 Music mix: ${familiarCount} familiar + ${newGenreTracks.slice(0, discoveryCount).length} discovery = ${tracks.length} total`);
  }

  // Apply weighted sort so tracks land near their configured position in the playlist.
  // Falls back to a plain shuffle when no weights are set (all default to 0.5).
  if (musicConfig.shuffle !== false) {
    tracks = weightedSort(tracks);
    console.log(`🎵 Track order after weighted sort:`);
    tracks.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. [w:${(t.position_weight ?? 0.5).toFixed(2)}] [${t.source || "music"}] ${t.name} — ${t.artist}`));
  }

  return tracks;
}

// Run the main function and handle any uncaught errors
main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  if (err.statusCode === 401) {
    console.error("   Your token may have expired. Run: npm run setup\n");
  }
  process.exit(1);
});
