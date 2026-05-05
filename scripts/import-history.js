#!/usr/bin/env node
// =============================================================================
// import-history.js — Spotify listening history importer
// =============================================================================
// Imports a Spotify data export into listening-history.json so that
// discovery tracks in Daily Drive are filtered to songs you've never heard.
//
// Handles both export formats Spotify provides:
//   Extended history  — endsong_*.json          (has spotify_track_uri)
//   Standard history  — StreamingHistory_music_*.json (artist + track name only)
//
// Safe to re-run: merges with existing history and ignores duplicates.
//
// Usage:
//   node scripts/import-history.js /path/to/my_spotify_data.zip
//   node scripts/import-history.js /path/to/extracted/directory/
//   npm run import-history -- /path/to/my_spotify_data.zip
// =============================================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync } = require("child_process");

const HISTORY_FILE = path.join(__dirname, "..", "listening-history.json");

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return { last_incremental_update: null, uris: [], names: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return { last_incremental_update: null, uris: [], names: [] };
  }
}

function normalizeName(artist, track) {
  return `${artist}|${track}`.toLowerCase().replace(/\s+/g, " ").trim();
}

// Recursively search dir for the folder that contains the history JSON files.
// Spotify zips sometimes nest everything under a subdirectory.
function findHistoryDir(dir) {
  const entries = fs.readdirSync(dir);
  const hasHistory = entries.some(
    (f) => f.endsWith(".json") && (f.startsWith("StreamingHistory") || f.startsWith("endsong"))
  );
  if (hasHistory) return dir;

  for (const entry of entries) {
    const sub = path.join(dir, entry);
    if (fs.statSync(sub).isDirectory()) {
      const found = findHistoryDir(sub);
      if (found) return found;
    }
  }
  return null;
}

function processDir(dir) {
  const uris  = new Set();
  const names = new Set();
  let filesProcessed = 0;

  const files = fs.readdirSync(dir).sort(); // sort so _0 _1 _2 are in order

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const isExtended = file.startsWith("endsong");
    const isStandard =
      file.startsWith("StreamingHistory_music") ||
      file.startsWith("StreamingHistory_audio") ||
      file.startsWith("StreamingHistory0"); // older format

    if (!isExtended && !isStandard) continue;

    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      console.error(`  ⚠️  Could not parse ${file}: ${err.message}`);
      continue;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      console.log(`  ⏭️  ${file} — empty, skipping`);
      continue;
    }

    // Detect format from first entry's fields
    const sample  = entries[0];
    const format  = sample.spotify_track_uri !== undefined ? "extended"
                  : sample.endTime           !== undefined ? "standard"
                  : "unknown";

    if (format === "unknown") {
      console.log(`  ℹ️  ${file} — unrecognized format, skipping`);
      continue;
    }

    let uriCount  = 0;
    let nameCount = 0;

    for (const entry of entries) {
      if (format === "extended") {
        const uri = entry.spotify_track_uri;
        // Skip podcasts (spotify:episode:) and nulls
        if (uri && uri.startsWith("spotify:track:")) {
          uris.add(uri);
          uriCount++;
        }
      } else {
        // Standard format — no URI, store normalized artist|track
        const artist = entry.artistName;
        const track  = entry.trackName;
        if (artist && track) {
          names.add(normalizeName(artist, track));
          nameCount++;
        }
      }
    }

    const countStr = format === "extended" ? `${uriCount} track URIs` : `${nameCount} name entries`;
    console.log(`  📄 ${file} (${format}): ${countStr}`);
    filesProcessed++;
  }

  if (filesProcessed === 0) {
    console.error("  ⚠️  No StreamingHistory or endsong files found.");
  }

  return { uris, names };
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/import-history.js <path/to/spotify_data.zip or directory>");
    process.exit(1);
  }

  const inputPath = path.resolve(arg);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Not found: ${inputPath}`);
    process.exit(1);
  }

  let workDir  = null;
  let tempDir  = null;
  const stat   = fs.statSync(inputPath);

  if (stat.isDirectory()) {
    workDir = inputPath;
    console.log(`📂 Reading from directory: ${workDir}`);
  } else if (inputPath.endsWith(".zip")) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-history-"));
    console.log(`📦 Extracting zip...`);
    try {
      execSync(`unzip -q "${inputPath}" -d "${tempDir}"`);
    } catch (err) {
      console.error(`❌ Failed to extract: ${err.message}`);
      console.error("   Ensure unzip is installed: sudo apt install unzip");
      process.exit(1);
    }
    workDir = tempDir;
  } else {
    console.error("❌ Input must be a .zip file or a directory");
    process.exit(1);
  }

  const historyDir = findHistoryDir(workDir);
  if (!historyDir) {
    console.error("❌ No StreamingHistory or endsong JSON files found in the export.");
    if (tempDir) try { execSync(`rm -rf "${tempDir}"`); } catch {}
    process.exit(1);
  }

  if (historyDir !== workDir) {
    console.log(`🔍 Found history files in: ${path.relative(workDir, historyDir)}/`);
  }
  console.log();

  const { uris: importedUris, names: importedNames } = processDir(historyDir);

  // Merge into existing history
  const history       = loadHistory();
  const existingUris  = new Set(history.uris  || []);
  const existingNames = new Set(history.names || []);

  let newUris  = 0;
  let newNames = 0;

  for (const uri of importedUris) {
    if (!existingUris.has(uri)) { existingUris.add(uri); newUris++; }
  }
  for (const name of importedNames) {
    if (!existingNames.has(name)) { existingNames.add(name); newNames++; }
  }

  const duplicates = (importedUris.size + importedNames.size) - newUris - newNames;

  history.uris  = Array.from(existingUris);
  history.names = Array.from(existingNames);

  // Set last_incremental_update if not already set so daily runs know their baseline
  if (!history.last_incremental_update) {
    history.last_incremental_update = new Date().toISOString();
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  console.log(`\n✅ Import complete:`);
  console.log(`   ${newUris.toLocaleString()} new track URIs added  (${existingUris.size.toLocaleString()} total)`);
  console.log(`   ${newNames.toLocaleString()} new name entries added (${existingNames.size.toLocaleString()} total)`);
  console.log(`   ${duplicates.toLocaleString()} duplicates skipped`);
  console.log(`   Saved to: listening-history.json`);

  if (tempDir) try { execSync(`rm -rf "${tempDir}"`); } catch {}
}

main();
