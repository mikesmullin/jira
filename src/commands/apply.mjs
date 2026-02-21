/**
 * jira apply - Apply pending changes to remote
 */

import { parseArgs } from 'util';
import { createInterface } from 'readline';
import { unlinkSync } from 'fs';
import { listStoredIds, resolveId } from '../lib/id.mjs';
import { readTicket, clearPending, saveIssue } from '../lib/storage.mjs';
import { updateIssue, addComment, getIssue, getTransitions, doTransition, deleteIssue, createLink, deleteLink, getIssueLinks } from '../lib/api.mjs';
import { getHostConfig, loadConfig } from '../lib/config.mjs';
import { mapFieldForJira } from '../lib/field-map.mjs';

const HELP = `
jira apply - Apply pending changes to remote Jira

USAGE:
  jira apply [--yes] [--host <name>]

OPTIONS:
  --yes           Skip confirmation prompt
  --host <name>   Only apply changes for specific host
  -h, --help      Show this help message

EXAMPLES:
  jira apply           # Interactive confirmation
  jira apply --yes     # Auto-confirm (for scripts)
`;

export async function runApply(args) {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
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

  const filtered = values.host
    ? pending.filter(t => t.host?.includes(values.host))
    : pending;

  if (filtered.length === 0) {
    console.log('No pending changes to apply.');
    return;
  }

  console.log(`Found ${filtered.length} ticket(s) with pending changes.\n`);

  if (!values.yes) {
    const confirmed = await confirm('Apply these changes? (y/N) ');
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  }

  let successCount = 0;
  let errorCount = 0;

  for (const ticketInfo of filtered) {
    try {
      await applyTicketChanges(ticketInfo);
      successCount++;
    } catch (error) {
      console.error(`✗ ${ticketInfo.key}: ${error.message}`);
      errorCount++;
    }
  }

  console.log(`\n✓ Applied: ${successCount}, Errors: ${errorCount}`);
}

async function applyTicketChanges(ticketInfo) {
  const resolved = resolveId(ticketInfo.id);
  const ticket = readTicket(resolved.filePath);
  const offline = ticket?.offline;

  const hostName = getHostNameFromUrl(ticket.host);

  // Handle deletion
  if (offline?.deleted) {
    console.log(`\nDeleting ${ticket.key}...`);
    await deleteIssue(hostName, ticket.key);
    unlinkSync(resolved.filePath);
    console.log(`  ✓ Deleted from Jira and removed local file`);
    return;
  }

  const pending = offline?.pending;
  if (!pending) return;

  console.log(`\nApplying changes to ${ticket.key}...`);

  // Refresh remote state before applying (conflict detection)
  let remoteIssue;
  try {
    remoteIssue = await getIssue(hostName, ticket.key);
    const remoteUpdated = remoteIssue.fields?.updated;
    const localSynced = ticket.offline?.last_sync;

    if (remoteUpdated && localSynced && new Date(remoteUpdated) > new Date(localSynced)) {
      console.log(`  ⚠ Remote ticket was modified since last sync`);
      console.log(`    Remote: ${remoteUpdated}`);
      console.log(`    Local:  ${localSynced}`);
      // Continue anyway, but warn
    }
  } catch (error) {
    console.warn(`  ⚠ Could not fetch remote state: ${error.message}`);
    // Continue with apply anyway
  }

  // Apply field updates
  const fieldUpdates = {};
  for (const [field, value] of Object.entries(pending)) {
    if (field === 'comments' || field === 'links') continue;
    if (field === 'status') {
      await applyStatusChange(hostName, ticket.key, value);
    } else {
      const mapped = await mapFieldForJira(hostName, field, value);
      fieldUpdates[mapped.field] = formatFieldValue(mapped.field, mapped.value);
    }
  }

  if (Object.keys(fieldUpdates).length > 0) {
    await updateIssue(hostName, ticket.key, fieldUpdates);
    console.log(`  ✓ Updated fields: ${Object.keys(fieldUpdates).join(', ')}`);
  }

  // Apply comments
  if (pending.comments?.length > 0) {
    for (const comment of pending.comments) {
      await addComment(hostName, ticket.key, comment.text);
      console.log(`  ✓ Added comment`);
    }
  }

  // Apply link changes
  if (pending.links?.length > 0) {
    for (const link of pending.links) {
      if (link.action === 'add') {
        await createLink(hostName, {
          type: { name: link.type },
          inwardIssue: { key: link.inwardKey },
          outwardIssue: { key: link.outwardKey },
        });
        console.log(`  ✓ Added link: ${link.inwardKey} → ${link.type} → ${link.outwardKey}`);
      } else if (link.action === 'remove') {
        await removeLinkBetweenIssues(hostName, link.inwardKey, link.outwardKey, link.type);
        console.log(`  ✓ Removed link: ${link.inwardKey} ← ${link.type} → ${link.outwardKey}`);
      }
    }
  }

  // Clear pending and refresh from remote
  const freshIssue = await getIssue(hostName, ticket.key);
  const hostConfig = getHostConfig(hostName);
  saveIssue(freshIssue, hostConfig.url);
  
  // Clear pending changes now that they've been applied
  clearPending(resolved.filePath);

  console.log(`  ✓ Synced latest from remote`);
}

async function applyStatusChange(hostName, issueKey, targetStatus) {
  const transitionsResult = await getTransitions(hostName, issueKey);
  const transitions = transitionsResult.transitions || [];

  const target = transitions.find(t =>
    t.name.toLowerCase() === targetStatus.toLowerCase() ||
    t.to?.name?.toLowerCase() === targetStatus.toLowerCase()
  );

  if (!target) {
    const available = transitions.map(t => t.name).join(', ');
    throw new Error(`Transition "${targetStatus}" not available. Available: ${available}`);
  }

  await doTransition(hostName, issueKey, target.id);
  console.log(`  ✓ Transitioned to: ${target.to?.name || targetStatus}`);
}

function formatFieldValue(field, value) {
  switch (field) {
    case 'assignee':
      return { name: value };
    case 'priority':
      return { name: value };
    case 'labels':
      return value;
    default:
      return value;
  }
}

function getHostNameFromUrl(url) {
  const config = loadConfig();
  for (const [name, host] of Object.entries(config.hosts)) {
    if (host.url === url) return name;
  }
  throw new Error(`Unknown host URL: ${url}`);
}

function hasPendingChanges(ticketInfo) {
  const offline = ticketInfo.offline;
  if (!offline) return false;

  // Check for deletion marker
  if (offline.deleted) return true;

  // Check for pending field changes, comments, or links
  const pending = offline.pending;
  if (!pending) return false;
  const hasFields = Object.keys(pending).some(k => k !== 'comments' && k !== 'links');
  const hasComments = pending.comments?.length > 0;
  const hasLinks = pending.links?.length > 0;
  return hasFields || hasComments || hasLinks;
}

/**
 * Remove a link between two issues by finding and deleting the link ID
 */
async function removeLinkBetweenIssues(hostName, inwardKey, outwardKey, linkType) {
  // Get all links from the inward issue
  const links = await getIssueLinks(hostName, inwardKey);

  // Find the matching link
  const matchingLink = links.find(link => {
    const typeName = link.type?.name?.toLowerCase();
    const targetType = linkType.toLowerCase();

    // Check outward link (this issue -> other)
    if (link.outwardIssue?.key === outwardKey && typeName === targetType) {
      return true;
    }
    // Check inward link (other -> this issue)
    if (link.inwardIssue?.key === outwardKey && typeName === targetType) {
      return true;
    }
    return false;
  });

  if (!matchingLink) {
    throw new Error(`No ${linkType} link found between ${inwardKey} and ${outwardKey}`);
  }

  await deleteLink(hostName, matchingLink.id);
}

async function confirm(prompt) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
