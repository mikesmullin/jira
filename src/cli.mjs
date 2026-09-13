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
import { runMarkdown } from './commands/markdown.mjs';
import {
  getDefaultHost,
  getHostForTicketKey,
  loadConfig,
  loadCredentialsFromPassman,
} from './lib/config.mjs';

const HELP = `
jira - Offline-first Jira CLI with local Markdown storage

USAGE:
  jira <command> [options]

COMMANDS:
  pull              Fetch tickets from Jira to local storage
  list              List local tickets (changed since last read)
  markdown <file>   Convert a Markdown file to Jira Wiki Markup (stdout)
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

const ONLINE_COMMANDS = new Set(['pull', 'apply', 'search', 'field', 'batch']);

function requestsHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

function hostFromArgs(args) {
  const index = args.findIndex((arg) => arg === '--host' || arg === '-H');
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith('--host=') || arg.startsWith('-H='));
  return inline ? inline.slice(inline.indexOf('=') + 1) : null;
}

function pullTicketIds(args) {
  const ids = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--host' || arg === '-H') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--host=') || arg.startsWith('-H=') || arg.startsWith('-')) continue;
    ids.push(arg);
  }
  return ids;
}

function credentialHostsFor(command, args) {
  const explicitHost = hostFromArgs(args);
  if (explicitHost) return explicitHost;

  if (command === 'pull') {
    const ticketIds = pullTicketIds(args);
    if (ticketIds.length > 0) {
      const mappedHosts = ticketIds.map((id) => getHostForTicketKey(id));
      const inferredHosts = [...new Set(mappedHosts.filter(Boolean))];
      if (mappedHosts.some((host) => !host)) inferredHosts.push(getDefaultHost());
      if (inferredHosts.length > 0) return [...new Set(inferredHosts)];
    } else {
      const config = loadConfig();
      return Object.keys(config.hosts || {}).filter((name) => config.hosts[name].sync?.length > 0);
    }
  }

  // Commands without an explicit host use Jira's configured default, just as
  // their command implementations do. This also enables the missing-token
  // prompt for an unqualified ticket pull.
  return getDefaultHost();
}

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
    if (ONLINE_COMMANDS.has(command) && !requestsHelp(commandArgs)) {
      const requestedHosts = credentialHostsFor(command, commandArgs);
      await loadCredentialsFromPassman(requestedHosts, {
        promptForMissing: true,
      });
    }

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
      case 'markdown':
        await runMarkdown(commandArgs);
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
