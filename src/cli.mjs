#!/usr/bin/env bun
/**
 * Jira CLI - Main entrypoint
 * Offline-first Jira CLI with local Markdown storage
 */

import { parseArgs } from 'util';

// Command imports
import { runPull } from './commands/pull.mjs';
import { runList } from './commands/list.mjs';
import { runView } from './commands/view.mjs';
import { runMark } from './commands/mark.mjs';
import { runOpen } from './commands/open.mjs';
import { runVisit } from './commands/visit.mjs';
import { runEdit } from './commands/edit.mjs';
import { runComment } from './commands/comment.mjs';
import { runLink } from './commands/link.mjs';
import { runPlan } from './commands/plan.mjs';
import { runApply } from './commands/apply.mjs';
import { runSearch } from './commands/search.mjs';
import { runField } from './commands/field.mjs';
import { runConfig } from './commands/config.mjs';
import { runBatch } from './commands/batch.mjs';
import { runClean } from './commands/clean.mjs';
import { runDelete } from './commands/delete.mjs';

const HELP = `
jira - Offline-first Jira CLI with local Markdown storage

USAGE:
  jira <command> [options]

COMMANDS:
  pull              Fetch tickets from Jira to local storage
  list              List local tickets (changed since last read)
  view <id>         View ticket (diff by default, or --full)
  mark <id>         Mark ticket as read (update last_read cursor)
  open <id>         Open ticket file in VS Code
  visit <id>        Open ticket permalink in browser
  edit <id>         Queue field changes (offline)
  comment <id>      Queue a comment (offline)
  link <id1> <id2>  Link two tickets in Jira
  delete <id>       Soft-delete ticket (queued for plan+apply)
  plan              Preview pending changes vs remote
  apply             Apply pending changes to remote
  batch <file>      Bulk create tickets from YAML 
  search <jql>      Search tickets with JQL (online, stdout)
  field             Custom field operations
  config            Manage hosts and sync patterns
  clean             Remove all ticket files from storage

OPTIONS:
  -h, --help        Show this help message
  -v, --version     Show version

Use "jira <command> --help" for more information about a command.
`;

const VERSION = '0.1.0';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    process.exit(0);
  }

  if (args[0] === '-v' || args[0] === '--version') {
    console.log(`jira version ${VERSION}`);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case 'pull':
        await runPull(commandArgs);
        break;
      case 'list':
        await runList(commandArgs);
        break;
      case 'view':
        await runView(commandArgs);
        break;
      case 'mark':
        await runMark(commandArgs);
        break;
      case 'open':
        await runOpen(commandArgs);
        break;
      case 'visit':
        await runVisit(commandArgs);
        break;
      case 'edit':
        await runEdit(commandArgs);
        break;
      case 'comment':
        await runComment(commandArgs);
        break;
      case 'link':
        await runLink(commandArgs);
        break;
      case 'plan':
        await runPlan(commandArgs);
        break;
      case 'apply':
        await runApply(commandArgs);
        break;
      case 'search':
        await runSearch(commandArgs);
        break;
      case 'batch':
        await runBatch(commandArgs);
        break;
      case 'field':
        await runField(commandArgs);
        break;
      case 'config':
        await runConfig(commandArgs);
        break;
      case 'clean':
        await runClean(commandArgs);
        break;
      case 'delete':
        await runDelete(commandArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "jira --help" for usage.');
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
