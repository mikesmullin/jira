/**
 * jira pull - Fetch tickets from Jira to local storage
 * Re-entrant: preserves offline key, always safe to run
 */

import { parseArgs } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { loadConfig, getHostConfig, getCacheDir } from '../lib/config.mjs';
import { searchAll, getComments, getChangelog, getIssue, getIssueUpdated } from '../lib/api.mjs';
import { readTicket } from '../lib/storage.mjs';
import { saveIssue, ensureStorageDirs } from '../lib/storage.mjs';
import { resolveId } from '../lib/id.mjs';

const HELP = `
jira pull - Fetch tickets from Jira to local storage

USAGE:
  jira pull [--host <name>] [--full]
  jira pull [id...] [--host <name>] [--full]

ARGUMENTS:
  [id...]           Optional ticket IDs to pull (Jira keys like SRE-12345)
                    When specified, pulls only these tickets instead of sync patterns

OPTIONS:
  --host <name>     Pull from specific host (required when pulling by ID
                    unless tickets already exist locally)
  --full            Force complete refresh, bypassing change detection
  -h, --help        Show this help message

BEHAVIOR:
  Pull is re-entrant and always safe to run:
  - Fetches tickets matching sync patterns in config.yaml
  - Uses incremental sync (updated since last pull) by default
  - For single tickets: skips pull if remote hasn't changed (compares timestamps)
  - Use --full to force a complete refresh, ignoring change detection
  - Overwrites remote data in local storage
  - Preserves the offline: key (pending edits, last_read, etc.)
  - Pending changes are never lost
  - Tickets with pending local changes are always pulled (to detect conflicts)

EXAMPLES:
  jira pull                       # Pull from all hosts (incremental)
  jira pull --host company        # Pull only from Company Jira
  jira pull --full                # Force full refresh
  jira pull SRE-123               # Pull a specific ticket (skips if unchanged)
  jira pull SRE-123 --full        # Force pull even if unchanged
  jira pull SRE-123 SRE-456       # Pull multiple specific tickets
  jira pull SRE-123 --host work   # Pull from specific host
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

  // If positional arguments provided, pull specific tickets
  if (positionals.length > 0) {
    const pulled = await pullSpecificTickets(positionals, values.host, values.full);
    console.log(`\n✓ Pulled ${pulled} ticket(s)`);
    return;
  }

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

/**
 * Pull specific tickets by ID (Jira key, short ID, or full ID)
 */
async function pullSpecificTickets(ids, hostName, forceFull = false) {
  const config = loadConfig();
  let pulled = 0;

  console.log(`\n📥 Pulling ${ids.length} specific ticket(s)...`);

  for (const id of ids) {
    try {
      const result = await pullSingleTicket(id, hostName, config, forceFull);
      if (result) {
        pulled++;
      }
    } catch (error) {
      console.error(`   ❌ ${id}: ${error.message}`);
    }
  }

  return pulled;
}

/**
 * Pull a single ticket by ID
 * Determines host from: explicit --host, existing local ticket, or default host
 * If forceFull is true, skip the updated timestamp check and always pull
 */
async function pullSingleTicket(id, explicitHost, config, forceFull = false) {
  // Check if input looks like a Jira key (e.g., SRE-12345)
  const isJiraKey = /^[A-Z]+-\d+$/i.test(id);
  const ticketKey = isJiraKey ? id.toUpperCase() : null;

  let targetHost = explicitHost;
  let resolvedKey = ticketKey;

  // If not a Jira key, try to resolve from local storage
  if (!isJiraKey) {
    try {
      const resolved = resolveId(id);
      resolvedKey = resolved.key;
      // Extract host name from host URL
      if (!targetHost && resolved.host) {
        targetHost = findHostByUrl(resolved.host, config);
      }
    } catch {
      throw new Error(
        `Cannot resolve ID "${id}" - use Jira key format (e.g., SRE-123) for new tickets`
      );
    }
  }

  // Determine which host to use
  if (!targetHost) {
    // Try to find host from existing local ticket
    if (!isJiraKey) {
      throw new Error(`Could not determine host for "${id}" - use --host flag`);
    }
    // Use default host if available
    if (config.default_host) {
      targetHost = config.default_host;
    } else {
      // Use first available host
      const hosts = Object.keys(config.hosts);
      if (hosts.length === 1) {
        targetHost = hosts[0];
      } else {
        throw new Error(`Multiple hosts configured - use --host flag to specify which one`);
      }
    }
  }

  const hostConfig = getHostConfig(targetHost);

  // Check if ticket exists locally and if we can skip the pull
  let existingTicket = null;
  try {
    const resolved = resolveId(resolvedKey);
    existingTicket = readTicket(resolved.filePath);
  } catch {
    // Ticket doesn't exist locally yet - proceed with full pull
  }

  // If ticket exists locally with no pending changes, check if remote has been updated
  // Skip this optimization if forceFull is set
  if (!forceFull && existingTicket && !existingTicket.offline?.pending) {
    const localUpdated = existingTicket.updated;
    if (localUpdated) {
      const remoteUpdated = await getIssueUpdated(targetHost, resolvedKey);
      if (remoteUpdated && remoteUpdated === localUpdated) {
        console.log(`   ○ ${resolvedKey}: not modified since last pull`);
        return false;
      }
    }
  }

  // Fetch the issue from Jira
  const issue = await getIssue(targetHost, resolvedKey);

  // Fetch comments
  let comments = [];
  try {
    comments = await getComments(targetHost, resolvedKey);
  } catch {
    console.log(`   ⚠ Could not fetch comments for ${resolvedKey}`);
  }

  // Fetch changelog
  let changelog = { histories: [] };
  try {
    changelog = await getChangelog(targetHost, resolvedKey);
  } catch {
    console.log(`   ⚠ Could not fetch changelog for ${resolvedKey}`);
  }

  // Save to local storage
  saveIssue(issue, hostConfig.url, { comments, changelog });

  const commentCount = comments.length > 0 ? ` (${comments.length} comments)` : '';
  console.log(
    `   ✓ ${issue.key}: ${issue.fields?.summary?.substring(0, 50) || 'No summary'}...${commentCount}`
  );

  return true;
}

/**
 * Find host name by URL
 */
function findHostByUrl(url, config) {
  for (const [name, hostConfig] of Object.entries(config.hosts)) {
    if (hostConfig.url === url) {
      return name;
    }
  }
  return null;
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

      // Track the max updated timestamp from fetched issues (use Jira's clock, not ours)
      let maxUpdated = null;

      for (const issue of issues) {
        // Track max updated time from Jira's perspective
        const issueUpdated = issue.fields?.updated;
        if (issueUpdated && (!maxUpdated || issueUpdated > maxUpdated)) {
          maxUpdated = issueUpdated;
        }

        // Fetch comments for this issue
        let comments = [];
        try {
          comments = await getComments(hostName, issue.key);
        } catch (commentErr) {
          // Comments fetch failed, continue without comments
          console.log(`   ⚠ Could not fetch comments for ${issue.key}`);
        }

        // Fetch changelog for this issue
        let changelog = { histories: [] };
        try {
          changelog = await getChangelog(hostName, issue.key);
        } catch (changelogErr) {
          // Changelog fetch failed, continue without it
          console.log(`   ⚠ Could not fetch changelog for ${issue.key}`);
        }

        const result = saveIssue(issue, hostConfig.url, { comments, changelog });
        const commentCount = comments.length > 0 ? ` (${comments.length} comments)` : '';
        console.log(`   ✓ ${issue.key}: ${issue.fields?.summary?.substring(0, 50) || 'No summary'}...${commentCount}`);
        hostPulled++;
      }

      // Update sync state using Jira's max updated timestamp (avoids clock drift issues)
      // Fall back to local time only if no issues were fetched
      const syncTimestamp = maxUpdated || pullStartTime;
      syncState.hosts[hostName].patterns[pKey] = syncTimestamp;
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
