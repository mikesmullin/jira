/**
 * jira batch - Bulk create tickets from YAML file 
 * Offline-first: preview with --plan, execute with --apply
 */

import { parseArgs } from 'util';
import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { createIssue, getIssue, updateIssue, getLinkTypes, getTransitions, doTransition } from '../lib/api.mjs';
import { getHostConfig, loadConfig, getDefaultHost } from '../lib/config.mjs';
import { saveIssue } from '../lib/storage.mjs';
import { getFieldId, getCommonFieldIds, hasFieldCache } from '../lib/fields.mjs';

const HELP = `
jira batch - Bulk create tickets from YAML file 

USAGE:
  jira batch <file> [OPTIONS]

OPTIONS:
  --plan            Preview what would be created (dry-run)
  --apply           Actually create the tickets
  --host <name>     Target host (default: from config)
  --config <file>   Load defaults from batch config file
  -h, --help        Show this help message

YAML SCHEMA:

  epic:               # Parent epic (optional)
    name: "Epic Title"
    summary: "Epic summary"
    description: "Description"
    # OR use existing epic:
    id: "SRE-12345"

  common:             # Override defaults (optional)
    project:
      id: 17500
      name: SRE
    labels: ["project-tag"]
    assigned_group: ".SRE - Team"
    default_issue_type: Task
    default_story_points: 0
    default_estimate: "0h"
    link_type: Dependency
    default_status: Open         # Transition after creation (optional)

  tasks:              # Required - list of tickets to create
    - summary: "Task title"
      description: "Task description"
      story_points: 3
      original_estimate: "4h"
      issue_type: Story           # Task, Story, Bug, Risk
      status: "In Progress"       # Override default_status for this task
      labels: ["extra-label"]
      components: ["Backend"]
      acceptance_criteria:
        - "Criterion 1"
        - "Criterion 2"
      links:
        - depends_on: "Other task summary"
        - depends_on: "SRE-12345"  # Existing ticket key

NOTES:
  - Run "jira field sync" first to cache custom field IDs
  - Links resolve by matching task summary or existing ticket key
  - Transitions are skipped if target status is not available

EXAMPLES:
  jira batch tasks.yaml --plan      # Preview what would be created
  jira batch tasks.yaml --apply     # Create the tickets
  jira batch tasks.yaml --config defaults.yaml --apply
`;

// Link type cache per host
const linkTypeCache = new Map();

export async function runBatch(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      plan: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      host: { type: 'string', short: 'H' },
      config: { type: 'string', short: 'c' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  if (!values.plan && !values.apply) {
    console.error('Must specify either --plan or --apply');
    console.log('Use --plan to preview, --apply to create tickets.');
    return;
  }

  const filePath = positionals[0];
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf8');
  const batch = yaml.load(content);

  if (!batch.tasks || !Array.isArray(batch.tasks) || batch.tasks.length === 0) {
    throw new Error('No tasks defined in YAML file');
  }

  const hostName = values.host || getDefaultHost();
  const hostConfig = getHostConfig(hostName);
  const config = loadConfig();

  // Load external config file if specified
  let externalConfig = {};
  if (values.config) {
    if (!existsSync(values.config)) {
      throw new Error(`Config file not found: ${values.config}`);
    }
    externalConfig = yaml.load(readFileSync(values.config, 'utf8'));
  }

  // Merge common settings
  const common = mergeCommon(config, hostConfig, batch.common, externalConfig);

  // Get field IDs for this host
  const fieldIds = getCommonFieldIds(hostName);

  // Warn if no field cache
  if (!hasFieldCache(hostName)) {
    console.warn(`⚠ No field cache for ${hostName}. Using default field IDs.`);
    console.warn(`  Run "jira field sync --host ${hostName}" for accurate field mapping.\n`);
  }

  if (values.plan) {
    await planBatch(batch, common, hostName, hostConfig, fieldIds);
  } else {
    await applyBatch(batch, common, hostName, hostConfig, fieldIds);
  }
}

/**
 * Merge common settings from config, host, batch file, and external config
 */
function mergeCommon(config, hostConfig, batchCommon, externalConfig = {}) {
  // Start with host-level defaults if any
  const hostDefaults = config.hosts?.[hostConfig.name]?.batch_defaults || {};

  // Layer: host defaults < external config < batch file common
  return {
    project: batchCommon?.project || externalConfig?.project || hostDefaults.project,
    labels: batchCommon?.labels || externalConfig?.labels || hostDefaults.labels || [],
    assigned_group: batchCommon?.assigned_group || externalConfig?.assigned_group || hostDefaults.assigned_group,
    additional_groups: batchCommon?.additional_groups || externalConfig?.additional_groups || hostDefaults.additional_groups || [],
    default_issue_type: batchCommon?.default_issue_type || externalConfig?.default_issue_type || hostDefaults.default_issue_type || 'Task',
    default_story_points: batchCommon?.default_story_points ?? externalConfig?.default_story_points ?? hostDefaults.default_story_points ?? 0,
    default_estimate: batchCommon?.default_estimate || externalConfig?.default_estimate || hostDefaults.default_estimate || '0h',
    components: batchCommon?.components || externalConfig?.components || hostDefaults.components || [],
    link_type: batchCommon?.link_type || externalConfig?.link_type || hostDefaults.link_type || 'Dependency',
    default_status: batchCommon?.default_status || externalConfig?.default_status || hostDefaults.default_status || null,
  };
}

/**
 * Preview what would be created (dry-run)
 */
async function planBatch(batch, common, hostName, hostConfig, fieldIds) {
  console.log(`\n📋 Batch Plan for ${hostName}\n`);
  console.log('─'.repeat(60));

  // Epic
  if (batch.epic) {
    if (batch.epic.id) {
      console.log(`\n📌 Epic: ${batch.epic.id} (existing)`);
    } else {
      console.log(`\n📌 Epic: ${batch.epic.name || batch.epic.summary} (NEW)`);
      if (batch.epic.summary) console.log(`   Summary: ${batch.epic.summary}`);
    }
  }

  // Project
  if (common.project) {
    console.log(`\n🏠 Project: ${common.project.name || common.project.key} (ID: ${common.project.id})`);
  }

  // Tasks
  console.log(`\n📝 Tasks to create: ${batch.tasks.length}\n`);

  for (let i = 0; i < batch.tasks.length; i++) {
    const task = batch.tasks[i];
    const issueType = task.issue_type || common.default_issue_type;
    const storyPoints = task.story_points ?? common.default_story_points;

    console.log(`  ${i + 1}. [${issueType}] ${task.summary}`);

    if (task.description) {
      const desc = task.description.split('\n')[0].substring(0, 60);
      console.log(`     ${desc}${task.description.length > 60 ? '...' : ''}`);
    }

    if (storyPoints) console.log(`     Story Points: ${storyPoints}`);
    if (task.original_estimate) console.log(`     Estimate: ${task.original_estimate}`);
    if (task.labels?.length) console.log(`     Labels: ${task.labels.join(', ')}`);

    if (task.links?.length) {
      for (const link of task.links) {
        if (link.depends_on) {
          console.log(`     → depends_on: ${link.depends_on}`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '─'.repeat(60));
  console.log(`\nPlan: ${batch.epic && !batch.epic.id ? '1 epic + ' : ''}${batch.tasks.length} task(s) to create`);
  console.log(`Link type: ${common.link_type}`);
  if (common.default_status) {
    console.log(`Transition to: ${common.default_status}`);
  }
  console.log('\nRun with --apply to create these tickets.');
}

/**
 * Actually create the tickets in Jira
 */
async function applyBatch(batch, common, hostName, hostConfig, fieldIds) {
  console.log(`\n🚀 Creating tickets in ${hostName}...\n`);

  const createdTasks = new Map(); // summary -> issueKey for linking
  let epicKey = null;

  // Step 1: Create or resolve epic
  if (batch.epic) {
    if (batch.epic.id) {
      epicKey = batch.epic.id;
      console.log(`📌 Using existing epic: ${epicKey}`);
    } else {
      epicKey = await createEpic(batch.epic, common, hostName, hostConfig, fieldIds);
      console.log(`✓ Created epic: ${epicKey}`);

      // Transition epic to default status if configured
      if (common.default_status) {
        try {
          await transitionToStatus(hostName, epicKey, common.default_status);
          console.log(`  ✓ Transitioned epic to: ${common.default_status}`);
        } catch (error) {
          console.warn(`  ⚠ Could not transition epic: ${error.message}`);
        }
      }
    }
  }

  // Step 2: Create tasks
  for (let i = 0; i < batch.tasks.length; i++) {
    const task = batch.tasks[i];
    console.log(`\n[${i + 1}/${batch.tasks.length}] Creating: ${task.summary}`);

    try {
      const issueKey = await createTask(task, common, epicKey, hostName, hostConfig, fieldIds);
      createdTasks.set(task.summary, issueKey);
      console.log(`  ✓ Created: ${issueKey}`);

      // Transition to default status if configured
      const targetStatus = task.status || common.default_status;
      if (targetStatus) {
        try {
          await transitionToStatus(hostName, issueKey, targetStatus);
          console.log(`  ✓ Transitioned to: ${targetStatus}`);
        } catch (error) {
          console.warn(`  ⚠ Could not transition: ${error.message}`);
        }
      }

      // Save to local storage
      const issue = await getIssue(hostName, issueKey);
      saveIssue(issue, hostConfig.url);
    } catch (error) {
      console.error(`  ✗ Failed: ${error.message}`);
    }
  }

  // Step 3: Create links (dependencies)
  console.log('\n📎 Creating links...');
  for (const task of batch.tasks) {
    if (!task.links?.length) continue;

    const sourceKey = createdTasks.get(task.summary);
    if (!sourceKey) continue;

    for (const link of task.links) {
      if (link.depends_on) {
        const targetKey = resolveLink(link.depends_on, createdTasks);
        if (targetKey) {
          try {
            await createLink(hostName, sourceKey, targetKey, common.link_type);
            console.log(`  ✓ ${sourceKey} depends_on ${targetKey}`);
          } catch (error) {
            console.error(`  ✗ Link failed: ${error.message}`);
          }
        }
      }
    }
  }

  // Summary
  console.log('\n' + '─'.repeat(60));
  console.log(`\n✓ Created ${createdTasks.size} ticket(s)`);
  if (common.default_status) {
    console.log(`  Transitioned to: ${common.default_status}`);
  }
  if (epicKey) {
    console.log(`  Epic: ${hostConfig.url}/browse/${epicKey}`);
  }
}

/**
 * Create an epic in Jira
 */
async function createEpic(epic, common, hostName, hostConfig, fieldIds) {
  const fields = {
    project: common.project,
    summary: epic.summary || epic.name,
    description: epic.description || '',
    issuetype: { name: 'Epic' },
  };

  // Epic name field (use dynamic lookup)
  if (epic.name && fieldIds.epicName) {
    fields[fieldIds.epicName] = epic.name;
  }

  // Labels
  const labels = [...(common.labels || []), ...(epic.labels || [])];
  if (labels.length) fields.labels = labels;

  const result = await createIssue(hostName, { fields });
  return result.key;
}

/**
 * Create a task in Jira
 */
async function createTask(task, common, epicKey, hostName, hostConfig, fieldIds) {
  const issueType = task.issue_type || common.default_issue_type;

  const fields = {
    project: common.project,
    summary: task.summary,
    description: formatDescription(task),
    issuetype: { name: issueType },
  };

  // Labels (merge common + task-specific)
  const labels = [...(common.labels || []), ...(task.labels || [])];
  if (labels.length) fields.labels = labels;

  // Story points (use dynamic field lookup)
  const storyPoints = task.story_points ?? common.default_story_points;
  if (storyPoints !== undefined && storyPoints !== null && fieldIds.storyPoints) {
    fields[fieldIds.storyPoints] = storyPoints;
  }

  // Time estimate
  const estimate = task.original_estimate || common.default_estimate;
  if (estimate && estimate !== '0h') {
    fields.timetracking = { originalEstimate: estimate };
  }

  // Epic link (use dynamic field lookup)
  if (epicKey && fieldIds.epicLink) {
    fields[fieldIds.epicLink] = epicKey;
  }

  // Assigned group (use dynamic field lookup)
  // Group fields expect { name: "groupName" } format
  if (common.assigned_group && fieldIds.assignedGroup) {
    fields[fieldIds.assignedGroup] = { name: common.assigned_group };
  }

  // Components
  const components = task.components || common.components;
  if (components?.length) {
    fields.components = components.map(c =>
      typeof c === 'string' ? { name: c } : c
    );
  }

  const result = await createIssue(hostName, { fields });
  return result.key;
}

/**
 * Format task description with acceptance criteria
 */
function formatDescription(task) {
  let desc = task.description || '';

  if (task.acceptance_criteria?.length) {
    desc += '\n\n*Acceptance Criteria:*\n';
    for (const criterion of task.acceptance_criteria) {
      desc += `* ${criterion}\n`;
    }
  }

  return desc;
}

/**
 * Resolve a link target (either existing key or created task summary)
 */
function resolveLink(target, createdTasks) {
  // If it looks like a Jira key, use it directly
  if (/^[A-Z]+-\d+$/i.test(target)) {
    return target.toUpperCase();
  }

  // Otherwise, look up by summary
  return createdTasks.get(target);
}

/**
 * Create a "depends on" link between two issues.
 *
 * LINK TYPE CONFIGURATION:
 * Issue link types (e.g., "Dependency", "Blocks") are configurable via
 * `common.link_type` in batch YAML, with runtime lookup from the
 * /issueLinkType API. Link type names vary by Jira instance!
 */
async function createLink(hostName, sourceKey, targetKey, linkTypeName = 'Dependency') {
  const host = getHostConfig(hostName);
  const url = `${host.url}${host.api}/issueLink`;

  // Try to resolve the actual link type name from cache
  const resolvedLinkType = await resolveLinkType(hostName, linkTypeName);

  const body = {
    type: { name: resolvedLinkType },
    inwardIssue: { key: sourceKey },
    outwardIssue: { key: targetKey },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${host.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Link creation failed: ${text}`);
  }
}

/**
 * Resolve link type name (lookup from cache or API if needed)
 */
async function resolveLinkType(hostName, linkTypeName) {
  // Check cache first
  if (linkTypeCache.has(hostName)) {
    const types = linkTypeCache.get(hostName);
    const match = types.find(t =>
      t.name.toLowerCase() === linkTypeName.toLowerCase() ||
      t.inward?.toLowerCase() === linkTypeName.toLowerCase() ||
      t.outward?.toLowerCase() === linkTypeName.toLowerCase()
    );
    if (match) return match.name;
  }

  // Try to fetch and cache link types
  try {
    const types = await getLinkTypes(hostName);
    linkTypeCache.set(hostName, types);

    const match = types.find(t =>
      t.name.toLowerCase() === linkTypeName.toLowerCase() ||
      t.inward?.toLowerCase() === linkTypeName.toLowerCase() ||
      t.outward?.toLowerCase() === linkTypeName.toLowerCase()
    );
    if (match) return match.name;
  } catch {
    // Fall through to default
  }

  // Return as-is if not found
  return linkTypeName;
}

/**
 * Transition an issue to a specific status.
 *
 * Looks up available transitions and finds one that leads to the target status.
 * This is used to move newly created tickets from their initial status (e.g., Backlog)
 * to a desired default status (e.g., Open, To Do).
 */
async function transitionToStatus(hostName, issueKey, targetStatus) {
  const transitionsResult = await getTransitions(hostName, issueKey);
  const transitions = transitionsResult.transitions || [];

  // Find a transition that leads to the target status
  const target = transitions.find(t =>
    t.name.toLowerCase() === targetStatus.toLowerCase() ||
    t.to?.name?.toLowerCase() === targetStatus.toLowerCase()
  );

  if (!target) {
    const available = transitions.map(t => `${t.name} → ${t.to?.name}`).join(', ');
    throw new Error(`No transition to "${targetStatus}". Available: ${available || 'none'}`);
  }

  await doTransition(hostName, issueKey, target.id);
}
