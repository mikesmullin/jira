/**
 * jira mark - Mark ticket(s) as read
 */

import { parseArgs } from 'util';
import { resolveId, listStoredIds } from '../lib/id.mjs';
import { markAsRead, clearLastRead, readTicket } from '../lib/storage.mjs';
import { getStorageDir } from '../lib/config.mjs';
import { join } from 'path';
import { green, pink, yellow, dim } from '../lib/colors.mjs';

const HELP = `
jira mark - Mark ticket as read (update last_read cursor)

USAGE:
  jira mark <id> [<id2> ...]
  jira mark --all
  jira mark --clear <id>

OPTIONS:
  --all         Mark all tickets as read
  --clear, -c   Clear the last_read marker (mark as unread)
  -h, --help    Show this help message

EXAMPLES:
  jira mark abc123              # Mark single ticket as read
  jira mark abc123 def456       # Mark multiple as read
  jira mark --all               # Mark all as read
  jira mark --clear abc123      # Clear last_read (mark as unread)
`;

export async function runMark(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      all: { type: 'boolean', short: 'a' },
      clear: { type: 'boolean', short: 'c' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.all) {
    await markAllAsRead();
    return;
  }

  if (positionals.length === 0) {
    console.log(HELP);
    return;
  }

  for (const idInput of positionals) {
    try {
      const resolved = resolveId(idInput);
      const ticketLabel = resolved.key || resolved.id.substring(0, 6);

      if (values.clear) {
        clearLastRead(resolved.filePath);
        console.log(yellow(`✓ Cleared last_read: ${ticketLabel}`));
      } else {
        markAsRead(resolved.filePath);
        console.log(green(`✓ Marked as read: ${ticketLabel}`));
      }
    } catch (error) {
      console.error(pink(`✗ ${idInput}: ${error.message}`));
    }
  }
}

/**
 * Mark all stored tickets as read
 */
async function markAllAsRead() {
  const storageDir = getStorageDir();
  const tickets = listStoredIds();

  if (tickets.length === 0) {
    console.log(dim('No tickets in storage.'));
    return;
  }

  // Filter to only unread/changed tickets
  const unread = tickets.filter(t => {
    const offline = t.offline || {};
    if (!offline.last_read) return true;
    if (t.updated && new Date(t.updated) > new Date(offline.last_read)) return true;
    return false;
  });

  if (unread.length === 0) {
    console.log(dim('All tickets are already marked as read.'));
    return;
  }

  let count = 0;
  for (const ticket of unread) {
    try {
      const filePath = join(storageDir, `${ticket.id}.md`);
      markAsRead(filePath);
      count++;
    } catch (error) {
      console.error(pink(`✗ ${ticket.key || ticket.id.substring(0, 6)}: ${error.message}`));
    }
  }

  console.log(green(`✓ Marked ${count} ticket(s) as read.`));
}
