/**
 * jira open - Open ticket file in VS Code
 */

import { parseArgs } from 'util';
import { spawn } from 'child_process';
import { resolveId } from '../lib/id.mjs';

const HELP = `
jira open - Open ticket file in VS Code

USAGE:
  jira open <id>

OPTIONS:
  -h, --help    Show this help message

EXAMPLES:
  jira open abc123      # Opens storage/<hash>.md in VS Code
  jira open SRE-12345   # Same, resolves key to file
`;

export async function runOpen(args) {
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

  console.log(`Opening ${resolved.key || resolved.id.substring(0, 6)}...`);

  const child = spawn('code', [resolved.filePath], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}
