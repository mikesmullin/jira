/**
 * jira plan - Preview pending changes vs remote
 */

import { parseArgs } from 'util';
import yaml from 'js-yaml';
import { listStoredIds, resolveId } from '../lib/id.mjs';
import { readTicket } from '../lib/storage.mjs';
import { getIssue } from '../lib/api.mjs';
import { getHostConfig, loadConfig } from '../lib/config.mjs';
import { pink, green, yellow } from '../lib/colors.mjs';

const HELP = `
jira plan - Preview pending changes vs current remote state

USAGE:
  jira plan [--host <name>]

OPTIONS:
  --host <name>   Only show changes for specific host
  -h, --help      Show this help message

EXAMPLES:
  jira plan                 # Show all pending changes
  jira plan --host company # Only Company Jira changes
`;

export async function runPlan(args) {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string', short: 'H' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const tickets = listStoredIds();
  const pending = tickets.filter(t => hasPendingChanges(t));

  // Filter by host if specified
  const filtered = values.host
    ? pending.filter(t => t.host?.includes(values.host))
    : pending;

  if (filtered.length === 0) {
    console.log('No pending changes.');
    return;
  }

  console.log('Planned changes:\n');

  let updateCount = 0;
  let commentCount = 0;
  let deleteCount = 0;
  let linkCount = 0;

  for (const ticketInfo of filtered) {
    const resolved = resolveId(ticketInfo.id);
    const ticket = readTicket(resolved.filePath);
    const offline = ticket?.offline;

    // Handle deletions
    if (offline?.deleted) {
      console.log(`${pink('-')} ${ticket.key} (${ticketInfo.shortId})`);
      console.log(`    ${pink('DELETE')} - Marked for deletion`);
      console.log('');
      deleteCount++;
      continue;
    }

    const pendingData = offline?.pending;
    if (!pendingData) continue;

    console.log(`${yellow('~')} ${ticket.key} (${ticketInfo.shortId})`);

    // Show field changes
    for (const [field, value] of Object.entries(pendingData)) {
      if (field === 'comments' || field === 'links') continue;

      const current = getFieldValue(ticket, field);
      console.log(`    ${field}: ${pink('"' + current + '"')} → ${green('"' + formatValue(value) + '"')}`);
      updateCount++;
    }

    // Show pending comments
    if (pendingData.comments?.length > 0) {
      for (const comment of pendingData.comments) {
        const preview = comment.text.substring(0, 40);
        console.log(`    ${green('+ comment:')} "${preview}${comment.text.length > 40 ? '...' : ''}"`);
        commentCount++;
      }
    }

    // Show pending links
    if (pendingData.links?.length > 0) {
      for (const link of pendingData.links) {
        if (link.action === 'add') {
          console.log(`    ${green('+ link:')} ${link.inwardKey} → ${link.type} → ${link.outwardKey}`);
        } else {
          console.log(`    ${pink('- link:')} ${link.inwardKey} ← ${link.type} → ${link.outwardKey}`);
        }
        linkCount++;
      }
    }

    console.log('');
  }

  console.log(`Plan: ${filtered.length} ticket(s) with changes`);
  const parts = [];
  if (deleteCount > 0) parts.push(`${deleteCount} deletion(s)`);
  parts.push(`${updateCount} field update(s)`);
  parts.push(`${commentCount} comment(s)`);
  if (linkCount > 0) parts.push(`${linkCount} link change(s)`);
  console.log(`      ${parts.join(', ')}`);
  console.log('\nRun "jira apply" to push these changes.');
}

function hasPendingChanges(ticketInfo) {
  const offline = ticketInfo.offline;
  if (!offline) return false;

  // Check for deletion marker
  if (offline.deleted) return true;

  // Check for pending field changes or comments or links
  const pending = offline.pending;
  if (!pending) return false;

  const hasFields = Object.keys(pending).some(k => k !== 'comments' && k !== 'links');
  const hasComments = pending.comments?.length > 0;
  const hasLinks = pending.links?.length > 0;

  return hasFields || hasComments || hasLinks;
}

function getFieldValue(ticket, field) {
  switch (field) {
    case 'status':
      return ticket.status?.name || 'Unknown';
    case 'assignee':
      return ticket.assignee?.displayName || 'Unassigned';
    case 'priority':
      return ticket.priority?.name || 'None';
    case 'labels':
      return (ticket.labels || []).join(', ') || 'None';
    default:
      return ticket[field] || 'Unknown';
  }
}

function formatValue(value) {
  if (Array.isArray(value)) {
    // Handle array of objects (e.g., multiselect fields)
    if (value.length > 0 && typeof value[0] === 'object') {
      return JSON.stringify(value);
    }
    return value.join(', ');
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}
