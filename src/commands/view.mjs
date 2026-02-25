/**
 * jira view - View a ticket (diff by default, or --full)
 */

import { parseArgs } from 'util';
import yaml from 'js-yaml';
import { resolveId } from '../lib/id.mjs';
import { readTicket } from '../lib/storage.mjs';
import { getChangelog } from '../lib/api.mjs';
import { getHostNameFromUrl } from '../lib/config.mjs';
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
`;

export async function runView(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      full: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      history: { type: 'boolean', default: false },
      revision: { type: 'string', short: 'r' },
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

  if (values.history) {
    await showHistory(ticket);
  } else if (values.revision) {
    await showRevision(ticket, parseInt(values.revision, 10));
  } else if (values.raw) {
    showRaw(ticket);
  } else if (values.full) {
    showFull(ticket);
  } else {
    showDiff(ticket);
  }
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
  console.log('Fetching changelog from Jira...\n');

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
  console.log('Fetching changelog from Jira...\n');

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
