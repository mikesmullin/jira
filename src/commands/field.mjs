/**
 * jira field - Custom field operations
 */

import { parseArgs } from 'util';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getFields, getFieldOptions, searchInsightObjects } from '../lib/api.mjs';
import { getCacheDir, getDefaultHost } from '../lib/config.mjs';

const HELP = `
jira field - Custom field operations

USAGE:
  jira field <subcommand>

SUBCOMMANDS:
  sync              Pull field definitions from remote to cache
  list              List cached custom fields
  get <id>          Get field details by ID
  find <name>       Search fields by name
  values <id>       Get allowed values for a field (requires --project and --type)
  insight <query>   Search Insight/Assets objects by name (IQL search)

OPTIONS:
  --host <name>       Jira host (default: from config)
  --project <key>     Project key (for values lookup)
  --type <name>       Issue type name (for values lookup, default: Task)
  --object-type <t>   Filter insight search by object type (e.g., Service)
  -h, --help          Show this help message

EXAMPLES:
  jira field sync --host company
  jira field list
  jira field find "assigned group"
  jira field get customfield_10314
  jira field values customfield_10325 --project SRE --type Task
  jira field insight "StarCraft"                    # Search all Insight objects
  jira field insight "Heroes" --object-type Service # Search only Services
`;

export async function runField(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      host: { type: 'string', short: 'H' },
      project: { type: 'string', short: 'p' },
      type: { type: 'string', short: 't' },
      'object-type': { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const subcommand = positionals[0];
  const hostName = values.host || getDefaultHost();

  switch (subcommand) {
    case 'sync':
      await syncFields(hostName);
      break;
    case 'list':
      listFields(hostName);
      break;
    case 'get':
      getFieldById(hostName, positionals[1]);
      break;
    case 'find':
      findFields(hostName, positionals.slice(1).join(' '));
      break;
    case 'values':
      await getFieldValues(hostName, positionals[1], values.project, values.type);
      break;
    case 'insight':
      await searchInsightValues(hostName, positionals.slice(1).join(' '), values['object-type']);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
  }
}

/**
 * Sync field definitions from remote Jira to local cache.
 *
 * WHY: Custom field IDs are host-specific and vary across Jira instances:
 *   - Company: customfield_10102 (Epic Link), customfield_10106 (Story Points)
 *   - Other: customfield_10003 (Story Points), customfield_13609 (Assigned Group)
 *
 * This function caches all field definitions locally so that batch operations
 * and field lookups can resolve human-readable names to the correct IDs.
 * Host-specific fallbacks exist in `src/lib/fields.mjs` for when no cache is available.
 */
async function syncFields(hostName) {
  console.log(`Fetching fields from ${hostName}...`);

  const fields = await getFields(hostName);
  const customFields = fields.filter(f => f.custom);

  console.log(`Found ${fields.length} fields (${customFields.length} custom)`);

  // Save to cache
  const cacheDir = getCacheDir();
  const fieldsDir = join(cacheDir, 'fields');

  if (!existsSync(fieldsDir)) {
    mkdirSync(fieldsDir, { recursive: true });
  }

  const filePath = join(fieldsDir, `${hostName}.yaml`);
  const data = {
    metadata: {
      host: hostName,
      synced_at: new Date().toISOString(),
      total_fields: fields.length,
      custom_fields: customFields.length,
    },
    // Store all fields with richer metadata (matching agent script format)
    fields: fields.reduce((acc, f) => {
      acc[f.id] = {
        name: f.name || 'Unknown',
        custom: f.custom || false,
        orderable: f.orderable || false,
        navigable: f.navigable || false,
        searchable: f.searchable || false,
        clauseNames: f.clauseNames || [],
        schema: f.schema || null,
      };

      // Add derived fields for easier lookup
      if (f.schema) {
        acc[f.id].type = f.schema.type || 'unknown';
        if (f.schema.items) {
          acc[f.id].items_type = f.schema.items;
        }
        if (f.schema.customId) {
          acc[f.id].custom_id = f.schema.customId;
        }
      }

      return acc;
    }, {}),
  };

  const yamlStr = yaml.dump(data, { lineWidth: 120, quotingType: "''", noRefs: true });
  writeFileSync(filePath, yamlStr, 'utf8');

  console.log(`✓ Saved to ${filePath}`);

  // Show key fields for reference
  console.log(`\n📝 Key fields for batch operations:`);
  const keyFieldNames = ['Epic Link', 'Epic Name', 'Story Points', 'Assigned Group', 'Sprint'];
  for (const name of keyFieldNames) {
    const field = fields.find(f => f.name === name);
    if (field) {
      console.log(`   ${field.id}: ${field.name}`);
    }
  }
}

function loadCachedFields(hostName) {
  const filePath = join(getCacheDir(), 'fields', `${hostName}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`No cached fields for ${hostName}. Run "jira field sync --host ${hostName}" first.`);
  }

  const content = readFileSync(filePath, 'utf8');
  return yaml.load(content);
}

function listFields(hostName) {
  const data = loadCachedFields(hostName);

  console.log(`Fields for ${hostName} (synced: ${data.metadata.synced_at}):\n`);
  console.log('ID                      NAME');
  console.log('─'.repeat(60));

  const entries = Object.entries(data.fields)
    .filter(([_, f]) => f.custom)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  for (const [id, field] of entries.slice(0, 50)) {
    console.log(`${id.padEnd(22)}  ${field.name}`);
  }

  if (entries.length > 50) {
    console.log(`\n... and ${entries.length - 50} more custom fields`);
  }

  console.log(`\nTotal: ${entries.length} custom fields`);
}

function getFieldById(hostName, fieldId) {
  if (!fieldId) {
    console.error('Usage: jira field get <id>');
    return;
  }

  const data = loadCachedFields(hostName);
  const field = data.fields[fieldId];

  if (!field) {
    console.error(`Field not found: ${fieldId}`);
    return;
  }

  console.log(yaml.dump({ [fieldId]: field }, { lineWidth: -1 }));
}

function findFields(hostName, query) {
  if (!query) {
    console.error('Usage: jira field find <name>');
    return;
  }

  const data = loadCachedFields(hostName);
  const queryLower = query.toLowerCase();

  const matches = Object.entries(data.fields)
    .filter(([id, f]) =>
      f.name.toLowerCase().includes(queryLower) ||
      id.toLowerCase().includes(queryLower) ||
      f.clauseNames?.some(c => c.toLowerCase().includes(queryLower))
    )
    .slice(0, 20);

  if (matches.length === 0) {
    console.log(`No fields matching: ${query}`);
    return;
  }

  console.log(`Fields matching "${query}":\n`);

  for (const [id, field] of matches) {
    console.log(`${id}`);
    console.log(`  Name: ${field.name}`);
    if (field.clauseNames?.length > 0) {
      console.log(`  JQL: ${field.clauseNames.join(', ')}`);
    }
    console.log('');
  }
}

async function getFieldValues(hostName, fieldId, projectKey, issueType) {
  if (!fieldId) {
    console.error('Usage: jira field values <id> --project <key> [--type <name>]');
    return;
  }

  if (!projectKey) {
    console.error('Error: --project <key> is required');
    console.error('Example: jira field values customfield_10325 --project SRE');
    return;
  }

  const type = issueType || 'Task';

  console.log(`Fetching allowed values for ${fieldId} in ${projectKey}/${type}...\n`);

  try {
    const options = await getFieldOptions(hostName, projectKey, type, fieldId);

    if (options.length === 0) {
      console.log('No allowed values found via standard API.');
      console.log('\nThis may be an Insight/Assets field. Use the insight subcommand to search:');
      console.log('  jira field insight "<search term>"');
      console.log('\nExample:');
      console.log('  jira field insight "StarCraft"');
      return;
    }

    console.log(`Allowed values (${options.length}):\n`);

    for (const opt of options) {
      // Handle different option formats
      if (opt.value) {
        console.log(`  value: "${opt.value}"${opt.id ? ` (id: ${opt.id})` : ''}`);
      } else if (opt.name) {
        console.log(`  name: "${opt.name}"${opt.key ? ` (key: ${opt.key})` : ''}`);
      } else {
        console.log(`  ${JSON.stringify(opt)}`);
      }
    }

    console.log('\nUsage example:');
    if (options[0]?.value) {
      console.log(`  jira edit <id> ${fieldId} '[{"value":"${options[0].value}"}]'`);
    } else if (options[0]?.name) {
      console.log(`  jira edit <id> ${fieldId} '[{"name":"${options[0].name}"}]'`);
    }
  } catch (error) {
    console.error(`Error fetching field values: ${error.message}`);
  }
}

/**
 * Search Insight/Assets objects by name using IQL
 */
async function searchInsightValues(hostName, query, objectType) {
  if (!query) {
    console.error('Usage: jira field insight <search term> [--object-type <type>]');
    console.error('Example: jira field insight "StarCraft"');
    console.error('Example: jira field insight "Heroes" --object-type Service');
    return;
  }

  const typeFilter = objectType ? ` (type: ${objectType})` : '';
  console.log(`Searching Insight objects for "${query}"${typeFilter}...\n`);

  try {
    // Build IQL query with optional object type filter
    let iql = `Name like "${query}"`;
    if (objectType) {
      iql = `objectType = "${objectType}" AND ${iql}`;
    }
    const objects = await searchInsightObjects(hostName, iql, 50);

    if (objects.length === 0) {
      console.log('No Insight objects found matching that query.');
      console.log('\nTry a different search term or check the Jira UI.');
      return;
    }

    console.log(`Found ${objects.length} Insight objects:\n`);

    for (const obj of objects) {
      console.log(`  ${obj.key}: ${obj.label}`);
      if (obj.objectType) {
        console.log(`    type: ${obj.objectType}`);
      }
    }

    console.log('\nUsage example (for Insight/Assets fields):');
    console.log(`  jira edit <id> <fieldId> '[{"key":"${objects[0].key}"}]'`);
    console.log('\nOr by ID:');
    console.log(`  jira edit <id> <fieldId> '[{"id":${objects[0].id}}]'`);
  } catch (error) {
    console.error(`Error searching Insight objects: ${error.message}`);
  }
}
