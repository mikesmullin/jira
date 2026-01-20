/**
 * jira list - List local tickets (changed since last read)
 */

import { parseArgs } from 'util';
import { listStoredIds } from '../lib/id.mjs';
import { loadConfig } from '../lib/config.mjs';
import { dim, cyan, yellow, green, pink } from '../lib/colors.mjs';

// Additional 24-bit colors for the list display
const STATUS_COLORS = {
  'in progress': '\x1b[38;2;102;178;255m',  // Blue
  'new': '\x1b[38;2;123;237;159m',           // Green
  'open': '\x1b[38;2;123;237;159m',          // Green
  'closed': '\x1b[38;2;140;140;140m',        // Gray
  'done': '\x1b[38;2;140;140;140m',          // Gray
  'resolved': '\x1b[38;2;140;140;140m',      // Gray
  'hold': '\x1b[38;2;255;209;102m',          // Yellow
  'blocked': '\x1b[38;2;255;121;121m',       // Red/Pink
};
const RESET = '\x1b[0m';

// Load tracked labels/components from config (with defaults)
function getDisplayConfig() {
  try {
    const config = loadConfig();
    return config.display || {};
  } catch {
    return {};
  }
}

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

  const label = values.all ? 'tickets in cache' : 'unread tickets';
  console.log(`📖 ${tickets.length} ${label} (showing ${displayed.length}):\n`);

  let index = 1;
  for (const ticket of displayed) {
    printTicketLine(ticket, index++);
  }

  if (remaining > 0) {
    console.log(dim(`\n   ... and ${remaining} more`));
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

/**
 * Colorize status text based on status name
 */
function colorizeStatus(status) {
  const statusLower = status.toLowerCase();
  const color = STATUS_COLORS[statusLower] || '';
  return color ? `${color}${status}${RESET}` : status;
}

/**
 * Format the change summary for display
 * Returns something like "(+no-estimate, assignee, status, 2 labels, 1 comment)" or empty string
 */
function formatChangeSummary(changes) {
  if (!changes) return '';

  const displayConfig = getDisplayConfig();
  const trackedLabels = displayConfig.tracked_labels || [];
  const trackedComponents = displayConfig.tracked_components || [];

  const parts = [];

  // Title and description first (cyan - important metadata)
  if (changes.title) {
    parts.push(cyan('title'));
  }
  if (changes.description) {
    parts.push(cyan('description'));
  }

  // Tracked labels with +/- prefix
  let untrackedLabelAdds = 0;
  let untrackedLabelRemoves = 0;
  
  for (const label of changes.labelsAdded || []) {
    if (trackedLabels.includes(label)) {
      parts.push(green(`+${label}`));
    } else {
      untrackedLabelAdds++;
    }
  }
  for (const label of changes.labelsRemoved || []) {
    if (trackedLabels.includes(label)) {
      parts.push(pink(`-${label}`));
    } else {
      untrackedLabelRemoves++;
    }
  }

  // Tracked components with +/- prefix
  let untrackedCompAdds = 0;
  let untrackedCompRemoves = 0;
  
  for (const comp of changes.componentsAdded || []) {
    if (trackedComponents.includes(comp)) {
      parts.push(green(`+${comp}`));
    } else {
      untrackedCompAdds++;
    }
  }
  for (const comp of changes.componentsRemoved || []) {
    if (trackedComponents.includes(comp)) {
      parts.push(pink(`-${comp}`));
    } else {
      untrackedCompRemoves++;
    }
  }

  // Named fields (cyan)
  for (const field of changes.namedFields || []) {
    parts.push(cyan(field));
  }

  // Generic counts for untracked items (dim)
  const totalLabelChanges = untrackedLabelAdds + untrackedLabelRemoves;
  if (totalLabelChanges > 0) {
    parts.push(dim(`${totalLabelChanges} label${totalLabelChanges > 1 ? 's' : ''}`));
  }

  const totalCompChanges = untrackedCompAdds + untrackedCompRemoves;
  if (totalCompChanges > 0) {
    parts.push(dim(`${totalCompChanges} component${totalCompChanges > 1 ? 's' : ''}`));
  }

  if (changes.otherFields > 0) {
    parts.push(dim(`${changes.otherFields} field${changes.otherFields > 1 ? 's' : ''}`));
  }

  // Comments last (cyan - important)
  if (changes.comments > 0) {
    parts.push(cyan(`${changes.comments} comment${changes.comments > 1 ? 's' : ''}`));
  }

  if (parts.length === 0) return '';

  return yellow(`(${parts.join(', ')})`);
}

function printTicketLine(ticket, index) {
  const shortId = ticket.shortId || ticket.id?.substring(0, 6) || '??????';
  const key = ticket.key || 'UNKNOWN';
  const status = ticket.statusName || ticket.status?.name || 'Unknown';
  const priority = ticket.priority?.name || ticket.priority || '-';
  const summary = ticket.summary || 'No summary';
  const changes = ticket.changesSinceRead;

  // Truncate summary to fit nicely
  const maxSummaryLen = 45;
  const displaySummary = summary.length > maxSummaryLen 
    ? summary.substring(0, maxSummaryLen) + '…' 
    : summary;

  // Format change summary
  const changeSummary = formatChangeSummary(changes);

  // Build the line with tab-separated columns
  // Format: <num>.\t<sha1>\t<ticket_id>\t<priority>\t<status>\t<title>\t<changes>
  const numCol = dim(`${index.toString().padStart(3)}.`);
  const shaCol = cyan(shortId);
  const keyCol = key;
  const prioCol = dim(`P${priority}`);
  const statusCol = colorizeStatus(status);
  const summaryCol = displaySummary;

  console.log(`  ${numCol}\t${shaCol}\t${keyCol}\t${prioCol}\t${statusCol}\t${summaryCol}\t${changeSummary}`);
}
