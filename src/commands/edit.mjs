/**
 * jira edit - Queue field changes (offline)
 */

import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import { resolveId } from '../lib/id.mjs';
import { queueEdit, readTicket } from '../lib/storage.mjs';
import { convertMarkdownToJira } from './markdown.mjs';
import { green, cyan, dim } from '../lib/colors.mjs';

const HELP = `
jira edit - Queue field changes (stored in offline.pending until apply)

USAGE:
  jira edit <id> <field> <value>
  jira edit <id> <field> --file <path>

OPTIONS:
  --file <path>   Read field value from file (auto-converts .md to Jira markup)
  -h, --help      Show this help message

FIELDS:
  status        Ticket status (e.g., "In Progress")
  assignee      Assignee email
  priority      Priority name (e.g., "High")
  labels        Add (+label) or remove (-label)
  summary       Short title/summary line
  description   Full description body (supports --file for multi-line)

EXAMPLES:
  jira edit abc123 status "In Progress"
  jira edit abc123 assignee "jdoe@company.com"
  jira edit abc123 priority High
  jira edit abc123 labels +urgent
  jira edit abc123 labels -wontfix
  jira edit abc123 summary "New summary text"
  jira edit abc123 description "Short description inline"
  jira edit abc123 description --file ./description.md
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
      file: { type: 'string', short: 'f' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length < 2) {
    console.log(HELP);
    return;
  }

  const [idInput, field, ...valueParts] = positionals;

  // Resolve value: --file wins over inline positionals
  let value;
  if (values.file) {
    let raw;
    try {
      raw = readFileSync(values.file, 'utf8');
    } catch (err) {
      throw new Error(`Could not read file "${values.file}": ${err.message}`);
    }
    // Auto-convert Markdown files to Jira Wiki Markup
    value = values.file.endsWith('.md') ? convertMarkdownToJira(raw) : raw;
  } else {
    if (valueParts.length === 0) {
      console.log(HELP);
      return;
    }
    value = valueParts.join(' ');
  }

  const resolved = resolveId(idInput);
  const ticket = readTicket(resolved.filePath);

  if (!ticket) {
    throw new Error(`Ticket not found: ${idInput}`);
  }

  // Handle special label syntax
  if (field === 'labels') {
    handleLabelEdit(resolved.filePath, ticket, value);
  } else {
    // Parse JSON for any field value (supports arrays/objects for mapped fields)
    const parsedValue = parseValue(value);
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
