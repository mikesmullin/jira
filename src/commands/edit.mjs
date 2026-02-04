/**
 * jira edit - Queue field changes (offline)
 */

import { parseArgs } from 'util';
import { resolveId } from '../lib/id.mjs';
import { queueEdit, readTicket } from '../lib/storage.mjs';
import { green, cyan, dim } from '../lib/colors.mjs';

const HELP = `
jira edit - Queue field changes (stored in offline.pending until apply)

USAGE:
  jira edit <id> <field> <value>

OPTIONS:
  -h, --help    Show this help message

FIELDS:
  status        Ticket status (e.g., "In Progress")
  assignee      Assignee email
  priority      Priority name (e.g., "High")
  labels        Add (+label) or remove (-label)

EXAMPLES:
  jira edit abc123 status "In Progress"
  jira edit abc123 assignee "jdoe@company.com"
  jira edit abc123 priority High
  jira edit abc123 labels +urgent
  jira edit abc123 labels -wontfix
`;

/**
 * Try to parse a value as JSON, return original if not valid JSON
 */
function parseValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function runEdit(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length < 3) {
    console.log(HELP);
    return;
  }

  const [idInput, field, ...valueParts] = positionals;
  const value = valueParts.join(' ');

  const resolved = resolveId(idInput);
  const ticket = readTicket(resolved.filePath);

  if (!ticket) {
    throw new Error(`Ticket not found: ${idInput}`);
  }

  // Handle special label syntax
  if (field === 'labels') {
    handleLabelEdit(resolved.filePath, ticket, value);
  } else {
    // Parse JSON for custom fields (supports arrays for multiselect fields)
    const parsedValue = field.startsWith('customfield_') ? parseValue(value) : value;
    queueEdit(resolved.filePath, field, parsedValue);
  }

  console.log(`${green('✓')} Queued edit: ${cyan(resolved.key || resolved.id.substring(0, 6))}`);
  console.log(`  ${field} ${dim('=')} ${green(value)}`);
  console.log(dim('\nRun "jira plan" to preview, "jira apply" to push.'));
}

function handleLabelEdit(filePath, ticket, value) {
  const pending = ticket.offline?.pending || {};
  const currentLabels = pending.labels || [...(ticket.labels || [])];

  if (value.startsWith('+')) {
    const label = value.substring(1);
    if (!currentLabels.includes(label)) {
      currentLabels.push(label);
    }
  } else if (value.startsWith('-')) {
    const label = value.substring(1);
    const idx = currentLabels.indexOf(label);
    if (idx >= 0) {
      currentLabels.splice(idx, 1);
    }
  } else {
    // Replace all labels
    currentLabels.length = 0;
    currentLabels.push(...value.split(',').map(l => l.trim()));
  }

  queueEdit(filePath, 'labels', currentLabels);
}
