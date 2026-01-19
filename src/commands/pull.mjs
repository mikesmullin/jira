/**
 * jira pull - Fetch tickets from Jira to local storage
 * Re-entrant: preserves offline key, always safe to run
 */

import { parseArgs } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { loadConfig, getHostConfig, getCacheDir } from '../lib/config.mjs';
import { searchAll, getComments } from '../lib/api.mjs';
import { saveIssue, ensureStorageDirs } from '../lib/storage.mjs';

const HELP = `
jira pull - Fetch tickets from Jira to local storage

USAGE:
  jira pull [--host <name>] [--full]

OPTIONS:
  --host <name>     Pull from specific host (default: all configured)
  --full            Ignore last_sync, pull everything fresh
  -h, --help        Show this help message

BEHAVIOR:
  Pull is re-entrant and always safe to run:
  - Fetches tickets matching sync patterns in config.yaml
  - Uses incremental sync (updated since last pull) by default
  - Use --full to force a complete refresh
  - Overwrites remote data in local storage
  - Preserves the offline: key (pending edits, last_read, etc.)
  - Pending changes are never lost

EXAMPLES:
  jira pull                    # Pull from all hosts (incremental)
  jira pull --host company    # Pull only from Company Jira
  jira pull --full             # Force full refresh
`;

/**
 * Get the path to the sync state cache file
 */
function getSyncStatePath() {
  return join(getCacheDir(), 'sync-state.yaml');
}

/**
 * Load sync state (last sync timestamps per host/pattern)
 */
function loadSyncState() {
  const statePath = getSyncStatePath();
  if (!existsSync(statePath)) {
    return { hosts: {} };
  }
  try {
    return yaml.load(readFileSync(statePath, 'utf8')) || { hosts: {} };
  } catch {
    return { hosts: {} };
  }
}

/**
 * Save sync state
 */
function saveSyncState(state) {
  const statePath = getSyncStatePath();
  writeFileSync(statePath, yaml.dump(state, { lineWidth: -1 }), 'utf8');
}

/**
 * Generate a stable hash for a sync pattern (for cache key)
 */
function patternKey(pattern) {
  return JSON.stringify(pattern).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 64);
}

export async function runPull(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      host: { type: 'string', short: 'H' },
      full: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  ensureStorageDirs();

  const config = loadConfig();
  const hostsToSync = values.host
    ? [values.host]
    : Object.keys(config.hosts).filter(h => config.hosts[h].sync?.length > 0);

  if (hostsToSync.length === 0) {
    console.log('No hosts configured with sync patterns.');
    console.log('Add sync patterns to config.yaml or use --host <name>');
    return;
  }

  let totalPulled = 0;

  for (const hostName of hostsToSync) {
    const pulled = await pullFromHost(hostName, config, values.full);
    totalPulled += pulled;
  }

  console.log(`\n✓ Pulled ${totalPulled} ticket(s) total`);
}

async function pullFromHost(hostName, config, forceFull) {
  const hostConfig = config.hosts[hostName];
  if (!hostConfig) {
    console.error(`Unknown host: ${hostName}`);
    return 0;
  }

  const syncPatterns = hostConfig.sync || [];
  if (syncPatterns.length === 0) {
    console.log(`⏭  ${hostName}: No sync patterns configured`);
    return 0;
  }

  console.log(`\n📥 Pulling from ${hostName}...`);

  // Load sync state for incremental sync
  const syncState = loadSyncState();
  if (!syncState.hosts[hostName]) {
    syncState.hosts[hostName] = { patterns: {} };
  }

  let hostPulled = 0;
  const pullStartTime = new Date().toISOString();

  for (const pattern of syncPatterns) {
    const baseJql = pattern.jql || buildJql(pattern);

    if (!baseJql) {
      console.log(`   ⚠  Skipping invalid pattern: ${JSON.stringify(pattern)}`);
      continue;
    }

    // Build the final JQL with optional incremental filter
    const pKey = patternKey(pattern);
    const lastSync = syncState.hosts[hostName].patterns[pKey];
    let jql = baseJql;

    if (!forceFull && lastSync) {
      // Add incremental filter: only get issues updated since last sync
      // Format: "2026-01-19 09:00" (Jira expects this format for updated field)
      const lastSyncDate = new Date(lastSync);
      const formattedDate = lastSyncDate.toISOString().slice(0, 16).replace('T', ' ');
      
      // Extract ORDER BY clause if present (must be outside parentheses)
      // Use case-insensitive multiline-aware matching
      const orderByMatch = baseJql.match(/\s+(ORDER\s+BY\s+[\s\S]+)$/i);
      const orderByClause = orderByMatch ? orderByMatch[1].trim() : '';
      const jqlWithoutOrder = orderByMatch ? baseJql.slice(0, orderByMatch.index).trim() : baseJql.trim();
      
      jql = `(${jqlWithoutOrder}) AND updated >= "${formattedDate}"`;
      if (orderByClause) {
        jql += ` ${orderByClause}`;
      }
      console.log(`   🔍 ${baseJql.trim()}`);
      console.log(`   ⏱  Incremental since: ${formattedDate}`);
    } else {
      console.log(`   🔍 ${jql}`);
      if (forceFull) console.log(`   🔄 Full refresh`);
    }

    try {
      const searchOptions = pattern.limit ? { limit: pattern.limit } : {};
      const issues = await searchAll(hostName, jql, searchOptions);
      console.log(`   📋 Found ${issues.length} issue(s)`);

      for (const issue of issues) {
        // Fetch comments for this issue
        let comments = [];
        try {
          comments = await getComments(hostName, issue.key);
        } catch (commentErr) {
          // Comments fetch failed, continue without comments
          console.log(`   ⚠ Could not fetch comments for ${issue.key}`);
        }

        const result = saveIssue(issue, hostConfig.url, { comments });
        const commentCount = comments.length > 0 ? ` (${comments.length} comments)` : '';
        console.log(`   ✓ ${issue.key}: ${issue.fields?.summary?.substring(0, 50) || 'No summary'}...${commentCount}`);
        hostPulled++;
      }

      // Update sync state for this pattern
      syncState.hosts[hostName].patterns[pKey] = pullStartTime;
    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
    }
  }

  // Save updated sync state
  saveSyncState(syncState);

  return hostPulled;
}

function buildJql(pattern) {
  const parts = [];

  if (pattern.project) {
    parts.push(`project = ${pattern.project}`);
  }

  if (pattern.jql) {
    parts.push(pattern.jql);
  }

  return parts.length > 0 ? parts.join(' AND ') : null;
}
