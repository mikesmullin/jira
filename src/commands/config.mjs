/**
 * jira config - Manage configuration
 */

import { parseArgs } from 'util';
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import { loadConfig, listHosts, getRootDir } from '../lib/config.mjs';
import { join } from 'path';

const HELP = `
jira config - Manage configuration (hosts, sync patterns)

USAGE:
  jira config <subcommand>

SUBCOMMANDS:
  show              Show current configuration
  hosts             List configured hosts
  patterns          Show sync patterns per host
  edit              Open config.yaml in editor

OPTIONS:
  --host <name>     Filter by host (for patterns)
  -h, --help        Show this help message

EXAMPLES:
  jira config show
  jira config hosts
  jira config patterns --host company
  jira config edit
`;

export async function runConfig(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      host: { type: 'string', short: 'H' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const subcommand = positionals[0];

  switch (subcommand) {
    case 'show':
      showConfig();
      break;
    case 'hosts':
      showHosts();
      break;
    case 'patterns':
      showPatterns(values.host);
      break;
    case 'edit':
      editConfig();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
  }
}

function showConfig() {
  const config = loadConfig();
  console.log(yaml.dump(config, { lineWidth: -1 }));
}

function showHosts() {
  const hosts = listHosts();

  console.log('Configured Jira hosts:\n');
  console.log('NAME          URL                                       SYNC');
  console.log('─'.repeat(70));

  for (const host of hosts) {
    const name = host.name.padEnd(12);
    const url = host.url.padEnd(40);
    const sync = host.syncPatterns > 0 ? `${host.syncPatterns} pattern(s)` : 'none';
    const marker = host.isDefault ? '*' : ' ';

    console.log(`${marker} ${name}  ${url}  ${sync}`);
  }

  console.log('\n* = default host');
}

function showPatterns(filterHost) {
  const config = loadConfig();

  const hosts = filterHost
    ? { [filterHost]: config.hosts[filterHost] }
    : config.hosts;

  for (const [name, host] of Object.entries(hosts)) {
    if (!host) {
      console.error(`Unknown host: ${name}`);
      continue;
    }

    console.log(`\n${name}:`);
    console.log(`  URL: ${host.url}`);
    console.log(`  Sync patterns:`);

    if (!host.sync || host.sync.length === 0) {
      console.log('    (none configured)');
    } else {
      for (const pattern of host.sync) {
        if (pattern.jql) {
          console.log(`    - jql: "${pattern.jql}"`);
        } else {
          console.log(`    - ${yaml.dump(pattern).trim()}`);
        }
      }
    }
  }
}

function editConfig() {
  const configPath = join(getRootDir(), 'config.yaml');
  console.log(`Opening ${configPath}...`);

  const child = spawn('code', [configPath], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}
