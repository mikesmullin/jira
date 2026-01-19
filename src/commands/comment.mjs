/**
 * jira comment - Queue a comment (offline)
 */

import { parseArgs } from 'util';
import { resolveId } from '../lib/id.mjs';
import { queueComment, readTicket } from '../lib/storage.mjs';
import { green, cyan, dim } from '../lib/colors.mjs';

const HELP = `
jira comment - Queue a comment (stored in offline.pending until apply)

USAGE:
  jira comment <id> <message>

OPTIONS:
  -h, --help    Show this help message

EXAMPLES:
  jira comment abc123 "Working on this now"
  jira comment SRE-12345 "Blocked on upstream dependency"
`;

export async function runComment(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length < 2) {
    console.log(HELP);
    return;
  }

  const [idInput, ...messageParts] = positionals;
  const message = messageParts.join(' ');

  const resolved = resolveId(idInput);
  const ticket = readTicket(resolved.filePath);

  if (!ticket) {
    throw new Error(`Ticket not found: ${idInput}`);
  }

  queueComment(resolved.filePath, message);

  console.log(`${green('✓')} Queued comment: ${cyan(resolved.key || resolved.id.substring(0, 6))}`);
  console.log(`  ${green('"' + message.substring(0, 50) + (message.length > 50 ? '...' : '') + '"')}`);
  console.log(dim('\nRun "jira plan" to preview, "jira apply" to push.'));
}
