/**
 * jira clean - Remove all ticket files from local storage
 */

import { parseArgs } from 'util';
import { readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getStorageDir, getCacheDir } from '../lib/config.mjs';
import { green, pink, dim } from '../lib/colors.mjs';

const HELP = `
jira clean - Remove all ticket files from local storage

USAGE:
  jira clean

OPTIONS:
  -h, --help    Show this help message

DESCRIPTION:
  Removes all .md ticket files from the storage directory.
  Does NOT remove cache files or example files.
  Data can be recovered by running "jira pull".

EXAMPLES:
  jira clean    # Remove all ticket files
`;

export async function runClean(args) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const storageDir = getStorageDir();

  // Find all ticket .md files (exclude examples and special files)
  let files;
  try {
    files = readdirSync(storageDir).filter(f => 
      f.endsWith('.md') && 
      !f.startsWith('_') && 
      !f.endsWith('.example')
    );
  } catch {
    files = [];
  }

  // Reset sync state (pull markers) so next pull fetches everything fresh
  const syncStatePath = join(getCacheDir(), 'sync-state.yaml');
  try {
    writeFileSync(syncStatePath, yaml.dump({ hosts: {} }, { lineWidth: -1 }), 'utf8');
  } catch (error) {
    console.error(pink(`✗ Failed to reset sync state: ${error.message}`));
  }

  if (files.length === 0) {
    console.log(dim('No ticket files to clean.'));
    console.log(dim('Sync state reset — next pull will fetch everything fresh.'));
    return;
  }

  let removed = 0;
  for (const file of files) {
    try {
      unlinkSync(join(storageDir, file));
      removed++;
    } catch (error) {
      console.error(pink(`✗ Failed to remove ${file}: ${error.message}`));
    }
  }

  console.log(green(`✓ Cleaned ${removed} ticket file(s).`));
  console.log(dim('  Sync state reset — next pull will fetch everything fresh.'));
}
