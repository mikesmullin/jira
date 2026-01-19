/**
 * jira search - Search tickets with JQL (online, stdout)
 * Pure JQL passthrough - no local parsing
 */

import { parseArgs } from 'util';
import yaml from 'js-yaml';
import { search } from '../lib/api.mjs';
import { getDefaultHost } from '../lib/config.mjs';

const HELP = `
jira search - Search tickets with JQL (online, outputs to stdout)

USAGE:
  jira search <jql> [OPTIONS]

OPTIONS:
  --host <name>       Jira host (default: from config)
  --limit <n>         Max results (default: 50)
  --fields <list>     Comma-separated field list
  --format <fmt>      Output format: table, yaml, json (default: table)
  -h, --help          Show this help message

EXAMPLES:
  jira search "project = SRE AND status = Open"
  jira search "assignee = currentUser() ORDER BY updated DESC" --limit 10
  jira search "project = SRE" --fields key,summary,status --format yaml
`;

export async function runSearch(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      host: { type: 'string', short: 'H' },
      limit: { type: 'string', short: 'l', default: '50' },
      fields: { type: 'string', short: 'f' },
      format: { type: 'string', default: 'table' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const jql = positionals.join(' ');
  const hostName = values.host || getDefaultHost();
  const limit = parseInt(values.limit, 10);
  const fields = values.fields?.split(',').map(f => f.trim());

  console.error(`Searching ${hostName}: ${jql}\n`);

  const result = await search(hostName, jql, {
    maxResults: limit,
    fields,
  });

  const issues = result.issues || [];

  if (issues.length === 0) {
    console.log('No results found.');
    return;
  }

  switch (values.format) {
    case 'json':
      console.log(JSON.stringify(issues, null, 2));
      break;
    case 'yaml':
      console.log(yaml.dump(issues.map(formatIssueForYaml), { lineWidth: -1 }));
      break;
    case 'table':
    default:
      printTable(issues);
      break;
  }

  console.error(`\nShowing ${issues.length} of ${result.total} results`);
}

function formatIssueForYaml(issue) {
  return {
    key: issue.key,
    summary: issue.fields?.summary,
    status: issue.fields?.status?.name,
    assignee: issue.fields?.assignee?.displayName,
    priority: issue.fields?.priority?.name,
    updated: issue.fields?.updated,
  };
}

function printTable(issues) {
  // Header
  console.log('KEY           STATUS          ASSIGNEE                SUMMARY');
  console.log('─'.repeat(80));

  for (const issue of issues) {
    const key = (issue.key || '').padEnd(12);
    const status = (issue.fields?.status?.name || '').padEnd(14);
    const assignee = (issue.fields?.assignee?.displayName || 'Unassigned').padEnd(22);
    const summary = (issue.fields?.summary || '').substring(0, 30);

    console.log(`${key}  ${status}  ${assignee}  ${summary}`);
  }
}
