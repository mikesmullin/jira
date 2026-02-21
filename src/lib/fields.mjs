/**
 * Field utilities for Jira CLI
 * Handles field ID lookups from cached field definitions
 *
 * KEY DECISION: Custom Field IDs are Host-Specific
 * ------------------------------------------------
 * Field IDs (e.g., "Story Points", "Epic Link") vary across Jira instances:
 *   - Company: customfield_10102 (Epic Link), customfield_10106 (Story Points)
 *   - Other: customfield_10003 (Story Points), customfield_13609 (Assigned Group)
 *
 * Use `jira field sync --host <name>` to cache field definitions, then this module
 * performs dynamic lookup. Host-specific fallbacks below are used when no cache exists.
 *
 * Link types (e.g., "Dependency", "Blocks") are also instance-specific and configurable
 * via `common.link_type` in batch YAML, with runtime lookup from /issueLinkType API.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getCacheDir } from './config.mjs';

// Well-known field mappings per host (fallbacks if cache not available)
// These vary by Jira instance! Always prefer cached lookups via `jira field sync`.
const WELL_KNOWN_FIELDS_BY_HOST = {
  company: {
    'epic name': 'customfield_10104',
    'epic link': 'customfield_10102',
    'story points': 'customfield_10106',
    'assigned group': 'customfield_10314',
    'sprint': 'customfield_10101',
  },
  // Generic fallback (common Jira Software defaults)
  _default: {
    'epic name': 'customfield_10011',
    'epic link': 'customfield_10008',
    'story points': 'customfield_10006',
    'sprint': 'customfield_10007',
  },
};

// Cache for loaded field data per host
const fieldCache = new Map();

/**
 * Load cached field definitions for a host
 */
export function loadFieldCache(hostName) {
  if (fieldCache.has(hostName)) {
    return fieldCache.get(hostName);
  }

  const filePath = join(getCacheDir(), 'fields', `${hostName}.yaml`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    const data = yaml.load(content);
    fieldCache.set(hostName, data);
    return data;
  } catch (error) {
    console.warn(`Warning: Could not load field cache for ${hostName}: ${error.message}`);
    return null;
  }
}

/**
 * Find a field ID by name (case-insensitive search)
 * Returns the field ID or null if not found
 */
export function findFieldId(hostName, fieldName) {
  const cache = loadFieldCache(hostName);
  const searchName = fieldName.toLowerCase().trim();

  // First check cache if available
  if (cache?.fields) {
    // Exact name match
    for (const [id, field] of Object.entries(cache.fields)) {
      if (field.name.toLowerCase() === searchName) {
        return id;
      }
    }

    // Check JQL clause names (e.g., "Epic Link", "Story Points")
    for (const [id, field] of Object.entries(cache.fields)) {
      if (field.clauseNames?.some(c => c.toLowerCase() === searchName)) {
        return id;
      }
    }

    // Partial match as fallback
    for (const [id, field] of Object.entries(cache.fields)) {
      if (field.name.toLowerCase().includes(searchName)) {
        return id;
      }
    }
  }

  // Fall back to host-specific well-known fields
  const hostFields = WELL_KNOWN_FIELDS_BY_HOST[hostName] || {};
  if (hostFields[searchName]) {
    return hostFields[searchName];
  }

  // Fall back to generic defaults
  const defaultFields = WELL_KNOWN_FIELDS_BY_HOST._default || {};
  if (defaultFields[searchName]) {
    return defaultFields[searchName];
  }

  return null;
}

/**
 * Get field ID with fallback to well-known defaults
 * Logs a warning if using fallback
 */
export function getFieldId(hostName, fieldName, defaultId = null) {
  const cache = loadFieldCache(hostName);
  const searchName = fieldName.toLowerCase().trim();

  // First try cache lookup
  if (cache?.fields) {
    const id = findFieldId(hostName, fieldName);
    if (id) return id;
  }

  // Check host-specific well-known fallbacks
  const hostFields = WELL_KNOWN_FIELDS_BY_HOST[hostName] || {};
  if (hostFields[searchName]) {
    if (!cache) {
      console.warn(`Warning: Using known field ID for ${hostName} "${fieldName}": ${hostFields[searchName]}`);
      console.warn(`Run "jira field sync --host ${hostName}" to cache field definitions.`);
    }
    return hostFields[searchName];
  }

  // Check generic fallbacks
  const defaultFields = WELL_KNOWN_FIELDS_BY_HOST._default || {};
  if (defaultFields[searchName]) {
    console.warn(`Warning: Using generic default field ID for "${fieldName}": ${defaultFields[searchName]}`);
    console.warn(`This may not work for ${hostName}. Run "jira field sync --host ${hostName}" to get correct IDs.`);
    return defaultFields[searchName];
  }

  if (defaultId) {
    console.warn(`Warning: Using provided default for "${fieldName}": ${defaultId}`);
    return defaultId;
  }

  return null;
}

/**
 * Get common Jira fields with dynamic lookups
 * Returns an object with resolved field IDs
 */
export function getCommonFieldIds(hostName) {
  return {
    epicName: getFieldId(hostName, 'epic name'),
    epicLink: getFieldId(hostName, 'epic link'),
    storyPoints: getFieldId(hostName, 'story points'),
    assignedGroup: getFieldId(hostName, 'assigned group'),
    targetStart: getFieldId(hostName, 'target start'),
    targetEnd: getFieldId(hostName, 'target end'),
    sprint: getFieldId(hostName, 'sprint'),
  };
}

/**
 * Check if field cache exists for a host
 */
export function hasFieldCache(hostName) {
  const filePath = join(getCacheDir(), 'fields', `${hostName}.yaml`);
  return existsSync(filePath);
}

/**
 * Clear the in-memory field cache
 */
export function clearFieldCache() {
  fieldCache.clear();
}
