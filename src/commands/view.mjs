/**
 * jira view - View a ticket (diff by default, or --full)
 */

import { parseArgs } from 'util';
import yaml from 'js-yaml';
import { resolveId } from '../lib/id.mjs';
import { readTicket, findChildrenByParentKey } from '../lib/storage.mjs';
import { getChangelog } from '../lib/api.mjs';
import { getHostNameFromUrl, getHierarchyFieldsForUrl } from '../lib/config.mjs';
import { pink, green, dim } from '../lib/colors.mjs';

const HELP = `
jira view - View a ticket (diff by default, or --full)

USAGE:
  jira view <id> [OPTIONS]

OPTIONS:
  --full              Show full current ticket (not diff)
  --raw               Show raw YAML frontmatter
  --history           Show revision history summary (online)
  --revision <n>      Show specific revision from history (online)
  --since <date>      Show changes since date (YYYY-MM-DD format, online)
  --recursive         Include all descendant tickets (from local cache)
  -h, --help          Show this help message

SUPPORTS:
  - Partial IDs: abc123
  - Full IDs: abc123def456...
  - Ticket keys: SRE-12345

EXAMPLES:
  jira view abc123             # Show diff since last read
  jira view SRE-12345 --full   # Show full current state
  jira view abc123 --raw       # Show raw YAML
  jira view abc123 --history   # Show revision timeline
  jira view abc123 --revision 3 # Show specific past version
  jira view abc123 --since 2026-01-01  # Changes since Jan 1
  jira view SRE-123 --recursive --full  # View ticket and all children
`;

export async function runView(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      full: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      history: { type: 'boolean', default: false },
      revision: { type: 'string', short: 'r' },
      since: { type: 'string', short: 's' },
      recursive: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const idInput = positionals[0];
  const resolved = resolveId(idInput);
  const ticket = readTicket(resolved.filePath);

  if (!ticket) {
    throw new Error(`Could not read ticket: ${resolved.filePath}`);
  }

  // Collect tickets to view (with descendants if requested)
  let ticketsToView = [ticket];
  if (values.recursive) {
    const hierarchyFields = getHierarchyFieldsForUrl(ticket.host);
    const descendants = findDescendantsLocal(ticket, hierarchyFields);
    ticketsToView = [ticket, ...descendants];
  }

  // View each ticket
  let first = true;
  for (const t of ticketsToView) {
    if (!first) {
      console.log('---');
    }
    first = false;

    await viewSingleTicket(t, values);
  }
}

/**
 * View a single ticket with the specified options
 */
async function viewSingleTicket(ticket, values) {
  if (values.history) {
    await showHistory(ticket);
  } else if (values.revision) {
    await showRevision(ticket, parseInt(values.revision, 10));
  } else if (values.since) {
    await showChangesSince(ticket, values.since);
  } else if (values.raw) {
    showRaw(ticket);
  } else if (values.full) {
    showFull(ticket);
  } else {
    showDiff(ticket);
  }
}

/**
 * Find all descendant tickets recursively from local storage only
 * Uses Parent Link and Epic Link fields to find children
 * No network calls - instant results from cache
 */
function findDescendantsLocal(ticket, hierarchyFields) {
  const descendants = [];
  const visited = new Set([ticket.key]);
  const queue = [ticket.key];

  while (queue.length > 0) {
    const parentKey = queue.shift();
    
    // Find children from local storage
    const children = findChildrenByParentKey(parentKey, hierarchyFields);
    
    for (const child of children) {
      if (!visited.has(child.key)) {
        visited.add(child.key);
        queue.push(child.key);
        descendants.push(child);
      }
    }
  }

  return descendants;
}

function showRaw(ticket) {
  const { _body, ...frontmatter } = ticket;
  const yamlStr = yaml.dump(frontmatter, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
  });
  console.log('---');
  console.log(yamlStr.trim());
  console.log('---');
}

function showFull(ticket) {
  // Print formatted view
  console.log(`# ${ticket.key}: ${ticket.summary}\n`);
  console.log(`**Status:** ${ticket.status?.name || 'Unknown'}`);
  console.log(`**Priority:** ${ticket.priority?.name || 'None'}`);
  console.log(`**Assignee:** ${ticket.assignee?.displayName || 'Unassigned'}`);
  console.log(`**Reporter:** ${ticket.reporter?.displayName || 'Unknown'}`);
  console.log(`**Project:** ${ticket.project?.name || ''} (${ticket.project?.key || ''})`);
  console.log(`**Created:** ${ticket.created?.split('T')[0] || ''}`);
  console.log(`**Updated:** ${ticket.updated?.split('T')[0] || ''}`);
  console.log(`**Link:** ${ticket.webLink}`);
  console.log('\n---\n');
  console.log('## Description\n');
  console.log(ticket.description || '_No description provided._');

  // Show comments if any
  if (ticket._comments && ticket._comments.length > 0) {
    console.log('\n---\n');
    console.log(`## Comments (${ticket._comments.length})\n`);
    for (const comment of ticket._comments) {
      const author = comment.author?.displayName || 'Unknown';
      const date = comment.created?.split('T')[0] || '';
      const time = comment.created?.split('T')[1]?.split('.')[0] || '';
      console.log(`### ${author} — ${date} ${time}\n`);
      console.log(comment.body || '_No content_');
      console.log('');
    }
  }

  // Show pending changes if any
  if (ticket.offline?.pending) {
    console.log('\n---\n');
    console.log('## Pending Changes (not yet applied)\n');
    console.log(yaml.dump(ticket.offline.pending, { lineWidth: -1 }));
  }
}

function showDiff(ticket) {
  const offline = ticket.offline || {};
  const previous = offline.previous;

  console.log(`# ${ticket.key}: ${ticket.summary}\n`);

  if (!previous) {
    // Never read before - show as new
    console.log('★ NEW TICKET (never viewed)\n');
    showFull(ticket);
    return;
  }

  const lastRead = offline.last_read;
  const updated = ticket.updated;

  if (lastRead && updated && new Date(updated) <= new Date(lastRead)) {
    console.log('✓ No changes since last read');
    console.log(`  Last read: ${lastRead}`);
    console.log(`  Last updated: ${updated}`);
    return;
  }

  console.log(`Changes since ${lastRead?.split('T')[0] || 'unknown'}:\n`);

  // Compare fields
  const changes = [];

  if (ticket.status?.name !== previous.status?.name) {
    changes.push({
      field: 'Status',
      from: previous.status?.name || 'None',
      to: ticket.status?.name || 'None',
    });
  }

  if (ticket.assignee?.displayName !== previous.assignee?.displayName) {
    changes.push({
      field: 'Assignee',
      from: previous.assignee?.displayName || 'Unassigned',
      to: ticket.assignee?.displayName || 'Unassigned',
    });
  }

  if (ticket.priority?.name !== previous.priority?.name) {
    changes.push({
      field: 'Priority',
      from: previous.priority?.name || 'None',
      to: ticket.priority?.name || 'None',
    });
  }

  if (ticket.summary !== previous.summary) {
    changes.push({
      field: 'Summary',
      from: previous.summary || '',
      to: ticket.summary || '',
    });
  }

  if (changes.length === 0) {
    console.log(dim('  (No tracked field changes detected)'));
    console.log(dim('  Updated timestamp changed - may have new comments'));
  } else {
    for (const change of changes) {
      console.log(`  ${change.field}:`);
      console.log(`    ${pink('- ' + change.from)}`);
      console.log(`    ${green('+ ' + change.to)}`);
      console.log('');
    }
  }

  console.log(`\nLink: ${ticket.webLink}`);
}

/**
 * Show revision history from Jira changelog
 */
async function showHistory(ticket) {
  const hostName = getHostNameFromUrl(ticket.host);
  if (!hostName) {
    throw new Error(`Cannot determine host for ticket: ${ticket.key}`);
  }

  console.log(`# ${ticket.key}: Revision History\n`);

  const changelog = await getChangelog(hostName, ticket.key);
  const histories = changelog.histories || [];

  if (histories.length === 0) {
    console.log('No revision history found.');
    return;
  }

  console.log(`Found ${histories.length} change(s):\n`);
  console.log('─'.repeat(60));

  for (let i = 0; i < histories.length; i++) {
    const entry = histories[i];
    const date = entry.created?.split('T')[0] || 'Unknown date';
    const time = entry.created?.split('T')[1]?.split('.')[0] || '';
    const author = entry.author?.displayName || 'Unknown';

    console.log(`\n[${i + 1}] ${date} ${time} by ${author}`);

    for (const item of entry.items || []) {
      const field = item.field || 'Unknown field';
      const from = item.fromString || '(empty)';
      const to = item.toString || '(empty)';

      if (from.length > 50 || to.length > 50) {
        console.log(`    ${field}: ${dim('(long value changed)')}`);
      } else {
        console.log(`    ${field}: ${pink('"' + from + '"')} → ${green('"' + to + '"')}`);
      }
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`\nTotal: ${histories.length} revision(s)`);
}

/**
 * Show a specific revision from history
 */
async function showRevision(ticket, revisionNum) {
  const hostName = getHostNameFromUrl(ticket.host);
  if (!hostName) {
    throw new Error(`Cannot determine host for ticket: ${ticket.key}`);
  }

  console.log(`# ${ticket.key}: Revision ${revisionNum}\n`);

  const changelog = await getChangelog(hostName, ticket.key);
  const histories = changelog.histories || [];

  if (revisionNum < 1 || revisionNum > histories.length) {
    throw new Error(`Invalid revision: ${revisionNum}. Valid range: 1-${histories.length}`);
  }

  const entry = histories[revisionNum - 1];
  const date = entry.created?.split('T')[0] || 'Unknown date';
  const time = entry.created?.split('T')[1]?.split('.')[0] || '';
  const author = entry.author?.displayName || 'Unknown';

  console.log(`**Date:** ${date} ${time}`);
  console.log(`**Author:** ${author}`);
  console.log('\n**Changes:**\n');

  for (const item of entry.items || []) {
    const field = item.field || 'Unknown field';
    const from = item.fromString || '(empty)';
    const to = item.toString || '(empty)';

    console.log(`  ${field}:`);
    console.log(`    ${pink('From: ' + from)}`);
    console.log(`    ${green('To:   ' + to)}`);
    console.log('');
  }
}

/**
 * Show changes since a specific date
 * Aggregates all field changes after the given date to show final values
 * Also shows comments made since that date
 */
async function showChangesSince(ticket, sinceDate) {
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
    throw new Error(`Invalid date format: ${sinceDate}. Use YYYY-MM-DD format.`);
  }

  const hostName = getHostNameFromUrl(ticket.host);
  if (!hostName) {
    throw new Error(`Cannot determine host for ticket: ${ticket.key}`);
  }

  const sinceTimestamp = new Date(sinceDate + 'T00:00:00').getTime();

  // Fetch changelog first to determine if there are changes
  const changelog = await getChangelog(hostName, ticket.key);
  const histories = changelog.histories || [];

  // Filter to entries after sinceDate
  const filteredHistories = histories.filter(entry => {
    const entryTimestamp = new Date(entry.created).getTime();
    return entryTimestamp >= sinceTimestamp;
  });

  // Filter comments since date (created OR updated since)
  const comments = ticket._comments || [];
  const recentComments = comments.filter(c => {
    const createdTimestamp = new Date(c.created).getTime();
    const updatedTimestamp = c.updated ? new Date(c.updated).getTime() : 0;
    return createdTimestamp >= sinceTimestamp || updatedTimestamp >= sinceTimestamp;
  });

  // Compact output if no changes AND no recent comments
  if (filteredHistories.length === 0 && recentComments.length === 0) {
    console.log(`# ${ticket.key}: No changes since ${sinceDate}.`);
    return;
  }

  // Full output for tickets with changes
  console.log(`# ${ticket.key}: "${ticket.summary}"`);
  
  // Show description (truncated if long)
  const desc = ticket.description || '_No description_';
  const descTruncated = desc.length > 200 ? desc.substring(0, 200) + '...' : desc;
  console.log(`Description: ${descTruncated}`);

  // Aggregate changes: track first "from" and last "to" for each field
  const fieldChanges = new Map();

  for (const entry of filteredHistories) {
    for (const item of entry.items || []) {
      const field = item.field || 'Unknown';
      if (!fieldChanges.has(field)) {
        fieldChanges.set(field, {
          field,
          from: item.fromString || '(empty)',
          to: item.toString || '(empty)',
          changeCount: 1,
          lastChanged: entry.created,
          lastAuthor: entry.author?.displayName || 'Unknown',
        });
      } else {
        // Update to latest value
        const existing = fieldChanges.get(field);
        existing.to = item.toString || '(empty)';
        existing.changeCount++;
        existing.lastChanged = entry.created;
        existing.lastAuthor = entry.author?.displayName || 'Unknown';
      }
    }
  }

  // Summary line
  const changeParts = [];
  if (filteredHistories.length > 0) {
    changeParts.push(`${filteredHistories.length} field change(s)`);
  }
  if (recentComments.length > 0) {
    changeParts.push(`${recentComments.length} comment(s)`);
  }
  console.log(`Since ${sinceDate}: ${changeParts.join(', ')}`);
  console.log('─'.repeat(60));

  // Show field changes
  if (fieldChanges.size > 0) {
    for (const [field, change] of fieldChanges) {
      const lastDate = change.lastChanged?.split('T')[0] || '';
      const countNote = change.changeCount > 1 ? ` (changed ${change.changeCount}x)` : '';
      
      console.log(`**${field}**${countNote}`);
      console.log(`  ${pink('Was: ' + change.from)}`);
      console.log(`  ${green('Now: ' + change.to)}`);
      console.log(`  ${dim(`Last changed: ${lastDate} by ${change.lastAuthor}`)}`);
    }
  }

  // Show recent comments
  if (recentComments.length > 0) {
    if (fieldChanges.size > 0) {
      console.log('');  // Separator between field changes and comments
    }
    console.log(`**Comments (${recentComments.length})**`);
    for (const comment of recentComments) {
      const author = comment.author?.displayName || 'Unknown';
      const date = comment.created?.split('T')[0] || '';
      const bodyPreview = (comment.body || '').substring(0, 150);
      const truncated = (comment.body || '').length > 150 ? '...' : '';
      console.log(`  ${dim(`[${date}]`)} ${author}: ${bodyPreview}${truncated}`);
    }
  }

  console.log('─'.repeat(60));
  console.log(`Link: ${ticket.webLink}`);
}
