/**
 * jira delete - Soft-delete a ticket (queued for plan+apply)
 */

import { parseArgs } from 'util';
import { resolveId } from '../lib/id.mjs';
import { updateOffline, readTicket } from '../lib/storage.mjs';
import { green, pink, yellow, dim, cyan } from '../lib/colors.mjs';

const HELP = `
jira delete - Soft-delete a ticket (queued for plan+apply)

USAGE:
  jira delete <id>
  jira delete --clear <id>

OPTIONS:
  --clear, -c   Undo soft-delete (remove deletion marker)
  -h, --help    Show this help message

DESCRIPTION:
  Marks a ticket for deletion locally. The deletion is queued
  and will be applied to the remote Jira when you run "jira apply".

  Use --clear to undo a soft-delete before applying.

EXAMPLES:
  jira delete abc123           # Mark for deletion
  jira delete --clear abc123   # Undo deletion marker
`;

export async function runDelete(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      clear: { type: 'boolean', short: 'c', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (positionals.length === 0) {
    console.log(HELP);
    return;
  }

  for (const idInput of positionals) {
    try {
      const resolved = resolveId(idInput);
      const ticket = readTicket(resolved.filePath);
      const ticketLabel = resolved.key || resolved.id.substring(0, 6);

      if (values.clear) {
        // Clear the deletion marker
        if (!ticket.offline?.deleted) {
          console.log(yellow(`⚠ ${ticketLabel}: Not marked for deletion`));
          continue;
        }
        updateOffline(resolved.filePath, { deleted: null });
        console.log(green(`✓ Cleared deletion: ${ticketLabel}`));
      } else {
        // Mark for deletion
        if (ticket.offline?.deleted) {
          console.log(yellow(`⚠ ${ticketLabel}: Already marked for deletion`));
          continue;
        }
        updateOffline(resolved.filePath, { 
          deleted: new Date().toISOString() 
        });
        console.log(pink(`✓ Marked for deletion: ${ticketLabel}`));
        console.log(dim('  Run "jira plan" to preview, "jira apply" to delete from Jira.'));
      }
    } catch (error) {
      console.error(pink(`✗ ${idInput}: ${error.message}`));
    }
  }
}
