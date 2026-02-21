/**
 * Host-configured field mapping utilities.
 *
 * Allows YAML aliases (e.g. services, target_start) to map to Jira fields
 * per-host via config.yaml, with optional value coercion strategies.
 */

import { loadConfig } from './config.mjs';
import { searchInsightObjects } from './api.mjs';

function normalizeSpec(spec) {
  if (!spec) return null;

  if (typeof spec === 'string') {
    return {
      jira_field: spec,
      type: 'passthrough',
    };
  }

  if (typeof spec === 'object') {
    return {
      jira_field: spec.jira_field || spec.field,
      type: spec.type || 'passthrough',
      object_type: spec.object_type || spec.objectType,
    };
  }

  return null;
}

export function getHostFieldMap(hostName) {
  const config = loadConfig();
  return config.hosts?.[hostName]?.field_map || {};
}

async function resolveInsightObject(hostName, inputValue, objectType = null) {
  if (typeof inputValue === 'object' && inputValue !== null) {
    if (inputValue.key || inputValue.id) return inputValue;
  }

  const text = String(inputValue || '').trim();
  if (!text) {
    throw new Error('Insight value cannot be empty');
  }

  if (/^CMDB-\d+$/i.test(text)) {
    return { key: text.toUpperCase() };
  }

  let iql = `Name like "${text}"`;
  if (objectType) {
    iql = `objectType = "${objectType}" AND ${iql}`;
  }

  const candidates = await searchInsightObjects(hostName, iql, 100);
  const typed = objectType
    ? candidates.filter(c => (c.objectType || '').toLowerCase() === objectType.toLowerCase())
    : candidates;

  if (typed.length === 0) {
    throw new Error(`No Insight objects found for "${text}"${objectType ? ` (type: ${objectType})` : ''}`);
  }

  const exactLabel = typed.find(c => (c.label || '').toLowerCase() === text.toLowerCase());
  if (exactLabel) {
    return { key: exactLabel.key };
  }

  const exactKey = typed.find(c => (c.key || '').toLowerCase() === text.toLowerCase());
  if (exactKey) {
    return { key: exactKey.key };
  }

  if (typed.length === 1) {
    return { key: typed[0].key };
  }

  const options = typed.slice(0, 5).map(c => `${c.key}:${c.label}`).join(', ');
  throw new Error(`Ambiguous Insight value "${text}". Candidates: ${options}`);
}

async function coerceValue(hostName, value, spec) {
  const type = spec?.type || 'passthrough';

  switch (type) {
    case 'insight-multi': {
      const values = Array.isArray(value) ? value : [value];
      const resolved = [];
      for (const item of values) {
        resolved.push(await resolveInsightObject(hostName, item, spec?.object_type));
      }
      return resolved;
    }
    case 'insight-single': {
      return resolveInsightObject(hostName, value, spec?.object_type);
    }
    case 'date':
    case 'string':
    case 'passthrough':
    default:
      return value;
  }
}

/**
 * Map a user-facing field alias to Jira field key and coerced value.
 */
export async function mapFieldForJira(hostName, fieldName, value) {
  const fieldMap = getHostFieldMap(hostName);
  const spec = normalizeSpec(fieldMap[fieldName]);

  if (!spec || !spec.jira_field) {
    return { field: fieldName, value };
  }

  const coerced = await coerceValue(hostName, value, spec);
  return {
    field: spec.jira_field,
    value: coerced,
    mapped: true,
  };
}
