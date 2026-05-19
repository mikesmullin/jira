/**
 * jira comment - Queue a comment (offline)
 */

import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import { resolveId } from '../lib/id.mjs';
import { queueComment, readTicket } from '../lib/storage.mjs';
import { convertMarkdownToJira } from './markdown.mjs';
import { green, cyan, dim } from '../lib/colors.mjs';

const HELP = `
jira comment - Queue a comment (stored in offline.pending until apply)

USAGE:
  jira comment <id> <message>
  jira comment <id> --file <path>

OPTIONS:
  --file <path>   Read comment body from file (auto-converts .md to Jira markup)
  -h, --help      Show this help message

EXAMPLES:
  jira comment abc123 "Working on this now"
  jira comment SRE-12345 "Blocked on upstream dependency"
  jira comment SRE-12345 --file tmp/csat-comment.md
`;

export async function runComment(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      file: { type: 'string', short: 'f' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || (positionals.length < 2 && !values.file)) {
    console.log(HELP);
    return;
  }

  const [idInput, ...messageParts] = positionals;

  let message;
  if (values.file) {
    let raw;
    try {
      raw = readFileSync(values.file, 'utf8');
    } catch (err) {
      throw new Error(`Could not read file "${values.file}": ${err.message}`);
    }
    message = values.file.endsWith('.md') ? convertMarkdownToJira(raw) : raw;
  } else {
    message = messageParts.join(' ');
  }

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
