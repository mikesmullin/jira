/**
 * jira visit - Open ticket permalink in default browser
 */

import { parseArgs } from 'util';
import { spawn } from 'child_process';
import { resolveId } from '../lib/id.mjs';
import { readTicket } from '../lib/storage.mjs';

const HELP = `
jira visit - Open ticket permalink in default browser

USAGE:
  jira visit <id>

OPTIONS:
  -h, --help    Show this help message

EXAMPLES:
  jira visit abc123      # Opens ticket URL in browser
  jira visit SRE-12345   # Same, using Jira key
`;

export async function runVisit(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const idInput = positionals[0];
  const resolved = resolveId(idInput);
  const ticket = readTicket(resolved.filePath);

  const url = ticket.webLink || `${ticket.host}/browse/${ticket.key}`;
  const label = resolved.key || resolved.id.substring(0, 6);

  console.log(`Opening ${label} in browser...`);
  console.log(`  ${url}`);

  // Use 'open' on macOS to open URL in default browser
  const child = spawn('open', [url], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}
