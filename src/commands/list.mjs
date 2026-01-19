/**
 * jira list - List local tickets (changed since last read)
 */

import { parseArgs } from 'util';
import { listStoredIds } from '../lib/id.mjs';

const HELP = `
jira list - List local tickets that have changed since last read

USAGE:
  jira list [OPTIONS]

OPTIONS:
  -l, --limit <n>      Max results (default: 20)
  -s, --status <s>     Filter by status
  -p, --project <p>    Filter by project
  -H, --host <name>    Filter by host
  -a, --all            Include already-read tickets
  -h, --help           Show this help message

EXAMPLES:
  jira list                          # Show unread/changed tickets
  jira list --all                    # Show all local tickets
  jira list --project SRE --limit 50 # Filter by project
`;

export async function runList(args) {
  const { values } = parseArgs({
    args,
    options: {
      limit: { type: 'string', short: 'l', default: '20' },
      status: { type: 'string', short: 's' },
      project: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H' },
      all: { type: 'boolean', short: 'a', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const limit = parseInt(values.limit, 10);
  let tickets = listStoredIds();

  if (tickets.length === 0) {
    console.log('No tickets in storage.');
    console.log('Run "jira pull" to fetch tickets from Jira.');
    return;
  }

  // Filter by project
  if (values.project) {
    const proj = values.project.toUpperCase();
    tickets = tickets.filter(t => t.key?.startsWith(proj + '-'));
  }

  // Filter by status
  if (values.status) {
    const status = values.status.toLowerCase();
    tickets = tickets.filter(t => t.status?.toLowerCase().includes(status));
  }

  // Filter by host
  if (values.host) {
    tickets = tickets.filter(t => t.host?.includes(values.host));
  }

  // Filter by unread/changed (unless --all)
  if (!values.all) {
    tickets = tickets.filter(t => isUnreadOrChanged(t));
  }

  // Sort by updated (newest first)
  tickets.sort((a, b) => {
    const aDate = a.updated || '';
    const bDate = b.updated || '';
    return bDate.localeCompare(aDate);
  });

  // Apply limit
  const displayed = tickets.slice(0, limit);
  const remaining = tickets.length - displayed.length;

  if (displayed.length === 0) {
    console.log('No tickets to show.');
    if (!values.all) {
      console.log('Use --all to show all tickets (including read).');
    }
    return;
  }

  console.log(`Showing ${displayed.length} of ${tickets.length} tickets:\n`);

  for (const ticket of displayed) {
    printTicketLine(ticket);
  }

  if (remaining > 0) {
    console.log(`\n... and ${remaining} more`);
  }
}

function isUnreadOrChanged(ticket) {
  const offline = ticket.offline || {};

  // Never read = unread
  if (!offline.last_read) {
    return true;
  }

  // Updated after last read = changed
  if (ticket.updated && offline.last_read) {
    return new Date(ticket.updated) > new Date(offline.last_read);
  }

  return false;
}

function printTicketLine(ticket) {
  const shortId = ticket.shortId || ticket.id?.substring(0, 6) || '??????';
  const key = ticket.key || 'UNKNOWN';
  const status = ticket.statusName || ticket.status?.name || 'Unknown';
  const updated = ticket.updated?.split('T')[0] || '';
  const summary = ticket.summary || 'No summary';

  // Determine if changed
  const offline = ticket.offline || {};
  const isNew = !offline.last_read;
  const isChanged = !isNew && ticket.updated &&
    new Date(ticket.updated) > new Date(offline.last_read);

  const marker = isNew ? '★' : isChanged ? '◆' : ' ';

  console.log(`${marker} ${shortId} / ${key} / ${updated} / ${status}`);
  console.log(`    ${summary.substring(0, 70)}${summary.length > 70 ? '...' : ''}`);

  // Show changed fields if applicable
  if (isChanged && offline.previous) {
    const changes = detectChanges(ticket, offline.previous);
    if (changes.length > 0) {
      console.log(`    [CHANGED: ${changes.join(', ')}]`);
    }
  }

  console.log('');
}

function detectChanges(current, previous) {
  const changes = [];

  // Handle both object and string forms of status
  const currentStatus = current.status?.name || current.statusName;
  const prevStatus = previous.status?.name || previous.status;
  if (currentStatus !== prevStatus) {
    changes.push('status');
  }

  // Handle assignee comparison
  const currentAssignee = current.assignee?.displayName;
  const prevAssignee = previous.assignee?.displayName || previous.assignee;
  if (currentAssignee !== prevAssignee) {
    changes.push('assignee');
  }

  // Handle priority comparison
  const currentPriority = current.priority?.name;
  const prevPriority = previous.priority?.name || previous.priority;
  if (currentPriority !== prevPriority) {
    changes.push('priority');
  }

  // Handle summary comparison
  if (current.summary !== previous.summary) {
    changes.push('summary');
  }

  return changes;
}
