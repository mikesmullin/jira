/**
 * ID resolution utilities
 * Handles Git-style short IDs and Jira key resolution
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getStorageDir } from './config.mjs';

/**
 * Generate SHA1 hash from host:key combination
 */
export function generateId(host, key) {
  const input = `${host}:${key}`;
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Get short ID (first 6 characters of hash)
 */
export function shortId(fullId) {
  return fullId.substring(0, 6);
}

/**
 * Resolve a partial ID, full ID, or Jira key to a full storage ID
 * Returns { id, filePath, key, host } or throws if not found/ambiguous
 */
export function resolveId(input) {
  const storageDir = getStorageDir();

  // Clean input
  const cleanInput = input.replace(/\.md$/, '').trim();

  // Try to find matching files
  let files;
  try {
    files = readdirSync(storageDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  } catch {
    throw new Error(`Storage directory not found: ${storageDir}`);
  }

  // Check if input looks like a Jira key (e.g., SRE-12345)
  const isJiraKey = /^[A-Z]+-\d+$/i.test(cleanInput);

  if (isJiraKey) {
    return resolveByKey(cleanInput.toUpperCase(), files, storageDir);
  }

  // Otherwise, resolve by ID prefix
  return resolveByIdPrefix(cleanInput.toLowerCase(), files, storageDir);
}

/**
 * Resolve by Jira key (e.g., SRE-12345)
 */
function resolveByKey(key, files, storageDir) {
  for (const file of files) {
    const filePath = join(storageDir, file);
    const frontmatter = readFrontmatter(filePath);

    if (frontmatter?.key?.toUpperCase() === key) {
      const id = file.replace(/\.md$/, '');
      return {
        id,
        filePath,
        key: frontmatter.key,
        host: frontmatter.host,
      };
    }
  }

  throw new Error(`Ticket not found: ${key}`);
}

/**
 * Resolve by ID prefix (Git-style)
 */
function resolveByIdPrefix(prefix, files, storageDir) {
  const matches = files.filter(f => f.toLowerCase().startsWith(prefix));

  if (matches.length === 0) {
    throw new Error(`No ticket found matching: ${prefix}`);
  }

  if (matches.length > 1) {
    const ids = matches.map(f => f.replace(/\.md$/, '').substring(0, 8));
    throw new Error(`Ambiguous ID "${prefix}" matches: ${ids.join(', ')}...`);
  }

  const file = matches[0];
  const filePath = join(storageDir, file);
  const id = file.replace(/\.md$/, '');
  const frontmatter = readFrontmatter(filePath);

  return {
    id,
    filePath,
    key: frontmatter?.key,
    host: frontmatter?.host,
  };
}

/**
 * Read just the YAML frontmatter from a markdown file
 */
function readFrontmatter(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (match) {
      return yaml.load(match[1]);
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * List all stored ticket IDs with basic info
 */
export function listStoredIds() {
  const storageDir = getStorageDir();

  let files;
  try {
    files = readdirSync(storageDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  } catch {
    return [];
  }

  return files.map(file => {
    const filePath = join(storageDir, file);
    const id = file.replace(/\.md$/, '');
    const frontmatter = readFrontmatter(filePath);

    return {
      id,
      shortId: shortId(id),
      key: frontmatter?.key,
      host: frontmatter?.host,
      summary: frontmatter?.summary,
      description: frontmatter?.description,
      status: frontmatter?.status,  // Keep full object for change detection
      statusName: frontmatter?.status?.name,  // Also include name for display
      assignee: frontmatter?.assignee,
      priority: frontmatter?.priority,
      labels: frontmatter?.labels,
      updated: frontmatter?.updated,
      offline: frontmatter?.offline,
      _comments: frontmatter?._comments,
      changesSinceRead: frontmatter?.offline?.changes_since_read,
    };
  });
}
