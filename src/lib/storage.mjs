/**
 * Local storage operations
 * Manages ticket Markdown files with YAML frontmatter
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import yaml from 'js-yaml';
import { getStorageDir, getCacheDir } from './config.mjs';
import { generateId } from './id.mjs';

/**
 * Ensure storage directories exist
 */
export function ensureStorageDirs() {
  const storageDir = getStorageDir();
  const cacheDir = getCacheDir();

  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true });
  }
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
}

/**
 * Convert Jira issue to storage format
 */
export function issueToStorage(issue, hostUrl) {
  const fields = issue.fields || {};

  return {
    key: issue.key,
    id: issue.id,
    host: hostUrl,
    summary: fields.summary,
    status: fields.status,
    priority: fields.priority,
    issuetype: fields.issuetype,
    assignee: fields.assignee,
    reporter: fields.reporter,
    project: fields.project,
    created: fields.created,
    updated: fields.updated,
    labels: fields.labels || [],
    components: fields.components || [],
    description: fields.description,
    webLink: `${hostUrl}/browse/${issue.key}`,
  };
}

/**
 * Generate Markdown body from issue data
 *
 * KEY DECISION: Markdown Line Breaks
 * -----------------------------------
 * Metadata fields render on separate lines using trailing double-spaces (`  `)
 * for Markdown line breaks, not blank lines between each field. This keeps
 * the metadata compact while ensuring proper rendering.
 */
function generateMarkdownBody(data) {
  const lines = [];

  lines.push(`# ${data.key}: ${data.summary || 'No summary'}`);
  lines.push('');
  // Trailing double-space creates <br> in rendered Markdown
  lines.push(`**Status:** ${data.status?.name || 'Unknown'}  `);
  lines.push(`**Priority:** ${data.priority?.name || 'None'}  `);
  lines.push(`**Assignee:** ${data.assignee?.displayName || 'Unassigned'}  `);
  lines.push(`**Reporter:** ${data.reporter?.displayName || 'Unknown'}  `);
  lines.push(`**Project:** ${data.project?.name || ''} (${data.project?.key || ''})  `);
  lines.push(`**Created:** ${data.created?.split('T')[0] || ''}  `);
  lines.push(`**Updated:** ${data.updated?.split('T')[0] || ''}  `);
  lines.push(`**Link:** [${data.key}](${data.webLink})`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(data.description || '_No description provided._');

  // Add comments section if there are any
  if (data._comments && data._comments.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Comments');
    lines.push('');

    for (const comment of data._comments) {
      const author = comment.author?.displayName || 'Unknown';
      const created = formatCommentDate(comment.created);
      lines.push(`### ${author} (${created})`);
      lines.push('');
      lines.push(comment.body || '_No content_');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format a comment date for display
 */
function formatCommentDate(dateString) {
  if (!dateString) return 'Unknown date';
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Save an issue to storage (re-entrant: preserves offline key)
 *
 * @param {Object} issue - Jira issue object from API
 * @param {string} hostUrl - Base URL of the Jira host
 * @param {Object} options - Optional settings
 * @param {Array} options.comments - Array of comment objects from Jira
 * @param {Object} options.changelog - Changelog object from Jira (with histories array)
 */
export function saveIssue(issue, hostUrl, options = {}) {
  ensureStorageDirs();

  const storageDir = getStorageDir();
  const id = generateId(hostUrl, issue.key);
  const filePath = join(storageDir, `${id}.md`);

  // Read existing offline data if file exists
  let existingOffline = {};
  let existingCommentCount = 0;
  if (existsSync(filePath)) {
    const existing = readTicket(filePath);
    existingOffline = existing?.offline || {};
    existingCommentCount = existing?._comments?.length || 0;
  }

  // Build storage data
  const data = issueToStorage(issue, hostUrl);
  data._stored_id = id;
  data._stored_at = new Date().toISOString();

  // Add comments if provided
  if (options.comments && options.comments.length > 0) {
    data._comments = options.comments.map(c => ({
      id: c.id,
      author: c.author ? { displayName: c.author.displayName, emailAddress: c.author.emailAddress } : null,
      body: c.body,
      created: c.created,
      updated: c.updated,
    }));
  }

  // Preserve and update offline section
  data.offline = {
    ...existingOffline,
    last_sync: new Date().toISOString(),
  };

  // Process changelog to compute changes since last_read
  const lastRead = existingOffline.last_read;
  if (options.changelog && options.changelog.histories) {
    const changesSinceRead = computeChangesSinceRead(
      options.changelog.histories,
      lastRead,
      existingCommentCount,
      data._comments?.length || 0
    );
    data.offline.changes_since_read = changesSinceRead;
  }

  // If this is a new ticket or updated, snapshot previous state for diffing
  if (!existingOffline.last_read) {
    // First time seeing this ticket
    data.offline.previous = null;
  }

  // Generate file content
  const frontmatter = yaml.dump(data, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
  });

  const body = generateMarkdownBody(data);
  const content = `---\n${frontmatter}---\n\n${body}\n`;

  writeFileSync(filePath, content, 'utf8');

  return { id, filePath, key: issue.key };
}

/**
 * Compute a summary of changes since last_read from changelog histories
 * Returns an object with detailed change info for display
 */
function computeChangesSinceRead(histories, lastRead, prevCommentCount, newCommentCount) {
  const changes = {
    title: false,
    description: false,
    // Named fields that were changed (e.g., ['assignee', 'status'])
    namedFields: [],
    // Count of other field changes not in tracked list
    otherFields: 0,
    // Comments added
    comments: 0,
    // Labels added (array of label names)
    labelsAdded: [],
    // Labels removed (array of label names)
    labelsRemoved: [],
    // Components added (array of component names)
    componentsAdded: [],
    // Components removed (array of component names)
    componentsRemoved: [],
  };

  // Count new comments (comments aren't in changelog, we compare counts)
  if (newCommentCount > prevCommentCount) {
    changes.comments = newCommentCount - prevCommentCount;
  }

  // If never read before, count everything as changed
  if (!lastRead) {
    // For unread tickets, we don't show a change summary (it's all new)
    return null;
  }

  const lastReadDate = new Date(lastRead);

  // Map of Jira field names to our display names
  // This will be populated from config, but we have defaults here
  const fieldNameMap = {
    'assignee': 'assignee',
    'status': 'status',
    'priority': 'priority',
    'timeoriginalestimate': 'estimate',
    'original estimate': 'estimate',
    'timespent': 'logged',
    'time spent': 'logged',
    'timeestimate': 'remaining',
    'remaining estimate': 'remaining',
    'target start': 'target start',
    'target end': 'target end',
    'duedate': 'due date',
    'due date': 'due date',
  };

  // Process changelog entries since last_read
  for (const history of histories) {
    const historyDate = new Date(history.created);
    if (historyDate <= lastReadDate) {
      continue; // Skip changes before last read
    }

    for (const item of history.items || []) {
      const field = item.field?.toLowerCase();

      if (field === 'summary') {
        changes.title = true;
      } else if (field === 'description') {
        changes.description = true;
      } else if (field === 'comment') {
        // Comments in changelog are usually just "added" events
        // We already count via comment count diff, so skip
      } else if (field === 'labels') {
        // Track label additions/removals
        const fromLabels = item.fromString ? item.fromString.split(' ') : [];
        const toLabels = item.toString ? item.toString.split(' ') : [];
        
        for (const label of toLabels) {
          if (label && !fromLabels.includes(label) && !changes.labelsAdded.includes(label)) {
            changes.labelsAdded.push(label);
          }
        }
        for (const label of fromLabels) {
          if (label && !toLabels.includes(label) && !changes.labelsRemoved.includes(label)) {
            changes.labelsRemoved.push(label);
          }
        }
      } else if (field === 'component') {
        // Track component additions/removals
        const fromComp = item.fromString || '';
        const toComp = item.toString || '';
        
        if (toComp && toComp !== fromComp) {
          if (!changes.componentsAdded.includes(toComp)) {
            changes.componentsAdded.push(toComp);
          }
        }
        if (fromComp && fromComp !== toComp) {
          if (!changes.componentsRemoved.includes(fromComp)) {
            changes.componentsRemoved.push(fromComp);
          }
        }
      } else {
        // Check if this is a tracked field
        const displayName = fieldNameMap[field];
        if (displayName && !changes.namedFields.includes(displayName)) {
          changes.namedFields.push(displayName);
        } else if (!displayName) {
          // Unknown field, count generically
          changes.otherFields++;
        }
      }
    }
  }

  // Return null if no changes
  const hasChanges = changes.title || 
    changes.description || 
    changes.namedFields.length > 0 || 
    changes.otherFields > 0 || 
    changes.comments > 0 ||
    changes.labelsAdded.length > 0 ||
    changes.labelsRemoved.length > 0 ||
    changes.componentsAdded.length > 0 ||
    changes.componentsRemoved.length > 0;

  if (!hasChanges) {
    return null;
  }

  return changes;
}

/**
 * Read a ticket from storage
 */
export function readTicket(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);

  if (!match) {
    return null;
  }

  const frontmatter = yaml.load(match[1]);
  const body = match[2];

  return { ...frontmatter, _body: body };
}

/**
 * Update offline metadata for a ticket
 */
export function updateOffline(filePath, updates) {
  const ticket = readTicket(filePath);
  if (!ticket) {
    throw new Error(`Ticket not found: ${filePath}`);
  }

  // Merge updates into offline section
  ticket.offline = {
    ...ticket.offline,
    ...updates,
  };

  // Regenerate file
  const { _body, ...frontmatterData } = ticket;

  const frontmatter = yaml.dump(frontmatterData, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
  });

  const content = `---\n${frontmatter}---\n\n${_body}`;
  writeFileSync(filePath, content, 'utf8');

  return ticket;
}

/**
 * Mark a ticket as read (update last_read cursor)
 */
export function markAsRead(filePath) {
  const ticket = readTicket(filePath);
  if (!ticket) {
    throw new Error(`Ticket not found: ${filePath}`);
  }

  // Snapshot current state as previous (for future diffing)
  const previous = {
    status: ticket.status,
    assignee: ticket.assignee,
    priority: ticket.priority,
    summary: ticket.summary,
    labels: ticket.labels,
    description: ticket.description,
    commentCount: ticket._comments?.length || 0,
  };

  return updateOffline(filePath, {
    last_read: new Date().toISOString(),
    previous,
  });
}

/**
 * Clear last_read marker (mark as unread)
 */
export function clearLastRead(filePath) {
  const ticket = readTicket(filePath);
  if (!ticket) {
    throw new Error(`Ticket not found: ${filePath}`);
  }

  return updateOffline(filePath, {
    last_read: null,
    previous: null,
  });
}

/**
 * Queue an edit to offline.pending
 */
export function queueEdit(filePath, field, value) {
  const ticket = readTicket(filePath);
  if (!ticket) {
    throw new Error(`Ticket not found: ${filePath}`);
  }

  const pending = ticket.offline?.pending || {};
  pending[field] = value;

  return updateOffline(filePath, { pending });
}

/**
 * Queue a comment to offline.pending
 */
export function queueComment(filePath, text) {
  const ticket = readTicket(filePath);
  if (!ticket) {
    throw new Error(`Ticket not found: ${filePath}`);
  }

  const pending = ticket.offline?.pending || {};
  const comments = pending.comments || [];

  comments.push({
    text,
    queued_at: new Date().toISOString(),
  });

  pending.comments = comments;

  return updateOffline(filePath, { pending });
}

/**
 * Clear pending changes after apply
 */
export function clearPending(filePath) {
  return updateOffline(filePath, { pending: null });
}

/**
 * Queue a link operation to offline.pending
 */
export function queueLink(filePath, linkData) {
  const ticket = readTicket(filePath);
  if (!ticket) {
    throw new Error(`Ticket not found: ${filePath}`);
  }

  const pending = ticket.offline?.pending || {};
  const links = pending.links || [];

  links.push({
    ...linkData,
    queued_at: new Date().toISOString(),
  });

  pending.links = links;

  return updateOffline(filePath, { pending });
}
