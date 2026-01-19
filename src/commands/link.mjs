/**
 * jira link - Queue link/unlink between two tickets (offline-first)
 */

import { parseArgs } from 'util';
import { resolveId } from '../lib/id.mjs';
import { readTicket, queueLink } from '../lib/storage.mjs';
import { green, cyan, dim } from '../lib/colors.mjs';

const HELP = `
jira link - Queue link/unlink between two tickets (offline-first)

USAGE:
  jira link <id1> <id2> [--type <type>]
  jira link <id1> <id2> --remove [--type <type>]

OPTIONS:
  --type, -t <type>   Link type (default: "Relates")
  --remove, -r        Remove/unlink instead of create
  --list              List available link types
  -h, --help          Show this help message

COMMON LINK TYPES:
  Relates             Generic relationship (default)
  Blocks              id1 blocks id2
  Dependency          id1 is depended on by id2
  Duplicate           id1 duplicates id2
  Cloners             id1 clones id2

EXAMPLES:
  jira link abc123 def456                    # Queue: relates abc123 to def456
  jira link SRE-123 SRE-456 --type Blocks    # Queue: SRE-123 blocks SRE-456
  jira link abc123 def456 -t Dependency      # Queue: abc123 is depended on by def456
  jira link abc123 def456 --remove           # Queue: remove link between tickets
`;

export async function runLink(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      type: { type: 'string', short: 't', default: 'Relates' },
      remove: { type: 'boolean', short: 'r', default: false },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.list) {
    console.log('Common Jira link types:\n');
    console.log('  Relates      - Generic relationship');
    console.log('  Blocks       - Source blocks target');
    console.log('  Dependency   - Source is depended on by target');
    console.log('  Duplicate    - Source duplicates target');
    console.log('  Cloners      - Source clones target');
    console.log('\nNote: Available types may vary by Jira instance.');
    return;
  }

  if (positionals.length < 2) {
    console.log(HELP);
    return;
  }

  const [id1, id2] = positionals;
  const linkType = values.type;
  const isRemove = values.remove;

  try {
    // Resolve both tickets
    const resolved1 = resolveId(id1);
    const resolved2 = resolveId(id2);
    const ticket1 = readTicket(resolved1.filePath);
    const ticket2 = readTicket(resolved2.filePath);

    if (!ticket1) {
      throw new Error(`Ticket not found: ${id1}`);
    }
    if (!ticket2) {
      throw new Error(`Ticket not found: ${id2}`);
    }

    // Verify both tickets are from the same host
    if (ticket1.host !== ticket2.host) {
      throw new Error('Cannot link tickets from different Jira hosts');
    }

    const label1 = ticket1.key;
    const label2 = ticket2.key;

    // Queue the link operation on the first ticket
    queueLink(resolved1.filePath, {
      action: isRemove ? 'remove' : 'add',
      type: linkType,
      inwardKey: ticket1.key,
      outwardKey: ticket2.key,
    });

    const action = isRemove ? 'unlink' : 'link';
    const symbol = isRemove ? '−' : '→';

    console.log(`${green('✓')} Queued ${action}: ${cyan(label1)} ${dim(symbol)} ${linkType} ${dim(symbol)} ${cyan(label2)}`);
    console.log(dim('\nRun "jira plan" to preview, "jira apply" to push.'));
  } catch (error) {
    console.error(`✗ Failed to queue link: ${error.message}`);
    process.exit(1);
  }
}
