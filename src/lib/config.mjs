/**
 * Configuration management for Jira CLI.
 *
 * Jira credentials live in protected `token` fields on Passman entries named
 * `jira-<host>`. The Passman library talks to the desktop agent over its local
 * socket; this module never opens a vault file or handles a master password.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { openVault, readFields, upsertFields } from '../../../passman/src/lib.mjs';
import { promptSecret } from './prompt.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..', '..');

let cachedConfig = null;
let cachedTokens = null;

const PASSMAN_TOKEN_FIELD = 'token';
const PASSMAN_PROTECTED_FIELDS = [PASSMAN_TOKEN_FIELD];

function passmanEntryForHost(hostName, hostConfig = {}) {
  return hostConfig.passman_entry || `jira-${hostName}`;
}

function ticketPrefixFromKey(issueKey) {
  const match = String(issueKey || '').trim().match(/^([A-Z][A-Z0-9]*)-\d+$/i);
  return match ? match[1].toUpperCase() : null;
}

function ticketPrefixesForHost(hostConfig = {}) {
  const configured = hostConfig.ticket_prefixes ?? hostConfig.prefixes ?? [];
  const values = Array.isArray(configured) ? configured : [configured];
  return values
    .map((prefix) => String(prefix || '').trim().replace(/-$/, '').toUpperCase())
    .filter(Boolean);
}

/**
 * Find the configured Jira host for an issue key such as `OPS-630818`.
 * Returns null when the prefix is not configured, allowing callers to fall
 * back to default_host.
 */
export function getHostForTicketKey(issueKey) {
  const prefix = ticketPrefixFromKey(issueKey);
  if (!prefix) return null;

  const config = loadConfig();
  const matches = Object.entries(config.hosts || {})
    .filter(([, hostConfig]) => ticketPrefixesForHost(hostConfig).includes(prefix))
    .map(([hostName]) => hostName);

  if (matches.length > 1) {
    throw new Error(`Ticket prefix ${prefix} is configured for multiple hosts: ${matches.join(', ')}`);
  }
  return matches[0] || null;
}

function environmentTokenForHost(hostName, defaultHost) {
  const suffix = hostName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return process.env[`JIRA_TOKEN_${suffix}`]
    || (hostName === defaultHost ? process.env.JIRA_TOKEN : '')
    || '';
}

function isMissingEntry(error, entry) {
  return error?.message === `No entry matching "${entry}"`;
}

function setEnvironmentToken(hostName, defaultHost, token) {
  const suffix = hostName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (hostName === defaultHost) process.env.JIRA_TOKEN = token;
  else process.env[`JIRA_TOKEN_${suffix}`] = token;
}

async function promptForMissingToken(hostName, entry) {
  while (true) {
    const token = await promptSecret(`Jira token for ${hostName} (${entry}): `);
    if (token.trim()) return token.trim();
    process.stderr.write('Jira token cannot be empty. Try again.\n');
  }
}

/**
 * Get the root directory of the jira project
 */
export function getRootDir() {
  return ROOT_DIR;
}

/**
 * Get the storage directory path
 */
export function getStorageDir() {
  return join(ROOT_DIR, 'storage');
}

/**
 * Get the cache directory path
 */
export function getCacheDir() {
  return join(ROOT_DIR, 'storage', '_cache');
}

/**
 * Load and parse config.yaml
 */
export function loadConfig() {
  if (cachedConfig) return cachedConfig;

  const configPath = join(ROOT_DIR, 'config.yaml');
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = readFileSync(configPath, 'utf8');
  cachedConfig = yaml.load(content);
  return cachedConfig;
}

/**
 * Load tokens already placed in this process by Passman (or explicit
 * environment overrides, which remain useful for scripts and CI).
 */
export function loadTokens() {
  if (cachedTokens) return cachedTokens;

  const config = loadConfig();
  const defaultHost = config.default_host || '';
  const token = environmentTokenForHost(defaultHost, defaultHost);
  if (!token) {
    throw new Error(
      `No Jira token is loaded. Open Passman, unlock the vault, enable Accessible for agents, `
      + `and add a protected token field to the jira-${defaultHost} entry.`
    );
  }

  cachedTokens = { hosts: { [defaultHost]: { token } } };
  return cachedTokens;
}

/**
 * Read Jira credentials directly from Passman's desktop agent.
 *
 * `hostNames` may restrict the read to one or more configured hosts. Missing
 * entries are left for getHostConfig() to report, while agent/vault failures
 * are surfaced unchanged. When `promptForMissing` is true, missing credentials
 * are requested with hidden terminal input and written back as protected
 * Passman fields. Values are held only in process memory after this call; the
 * durable copy remains protected in Passman.
 */
export async function loadCredentialsFromPassman(hostNames = null, { promptForMissing = false } = {}) {
  const config = loadConfig();
  const configuredHosts = Object.keys(config.hosts || {});
  const defaultHost = config.default_host || '';
  const environmentHosts = configuredHosts.filter((name) => environmentTokenForHost(name, defaultHost));
  const requested = hostNames == null
    ? (environmentHosts.length > 0 ? environmentHosts : configuredHosts)
    : (Array.isArray(hostNames) ? hostNames : [hostNames]);
  const names = [...new Set(requested.filter(Boolean))];

  for (const name of names) {
    if (!config.hosts?.[name]) {
      const available = configuredHosts.join(', ');
      throw new Error(`Unknown host: ${name}. Available: ${available}`);
    }
  }

  const hosts = { ...(cachedTokens?.hosts || {}) };
  const missing = [];

  for (const name of names) {
    // An explicit --host request makes Passman authoritative: even an
    // environment override is not allowed to bypass the missing-entry prompt.
    const token = promptForMissing ? '' : environmentTokenForHost(name, defaultHost);
    if (token) hosts[name] = { token };
    else if (promptForMissing || !hosts[name]?.token) missing.push(name);
  }

  if (missing.length > 0) {
    const vault = await openVault();
    for (const name of missing) {
      const entry = passmanEntryForHost(name, config.hosts[name]);
      let fields;
      try {
        fields = await readFields(vault, entry, [PASSMAN_TOKEN_FIELD]);
      } catch (error) {
        if (!isMissingEntry(error, entry)) throw error;
        fields = {};
      }
      let token = fields[PASSMAN_TOKEN_FIELD];
      if (!token && promptForMissing) {
        token = await promptForMissingToken(name, entry);
      }
      if (token) {
        token = String(token);
        if (!fields[PASSMAN_TOKEN_FIELD]) {
          await upsertFields(
            vault,
            entry,
            { [PASSMAN_TOKEN_FIELD]: token },
            { protectedFields: PASSMAN_PROTECTED_FIELDS },
          );
        }
        hosts[name] = { token };
        setEnvironmentToken(name, defaultHost, token);
      }
    }
  }

  cachedTokens = { hosts };
  const defaultToken = hosts[defaultHost]?.token;
  if (defaultToken && !process.env.JIRA_TOKEN) process.env.JIRA_TOKEN = defaultToken;
  return cachedTokens;
}

/**
 * Get configuration for a specific host
 */
export function getHostConfig(hostName) {
  const config = loadConfig();
  const tokens = loadTokens();

  const name = hostName || config.default_host;
  const hostConfig = config.hosts?.[name];

  if (!hostConfig) {
    const available = Object.keys(config.hosts || {}).join(', ');
    throw new Error(`Unknown host: ${name}. Available: ${available}`);
  }

  const token = tokens.hosts?.[name]?.token;
  if (!token || token === 'YOUR_PAT_TOKEN_HERE') {
    const entry = passmanEntryForHost(name, hostConfig);
    throw new Error(`No valid token configured for host: ${name}. Add a protected token field to Passman entry ${entry}.`);
  }

  return {
    name,
    url: hostConfig.url,
    api: hostConfig.api || '/rest/api/2',
    token,
    sync: hostConfig.sync || [],
    hierarchy_fields: normalizeHierarchyFields(hostConfig.hierarchy_fields),
  };
}

/**
 * Normalize hierarchy_fields config to consistent format
 * Handles both old format (flat string) and new format (nested object)
 */
function normalizeHierarchyFields(fields) {
  const defaults = {
    parent_link: { field_id: 'customfield_10301', jql_name: 'Parent Link' },
    epic_link: { field_id: 'customfield_10102', jql_name: 'Epic Link' },
  };

  if (!fields) return defaults;

  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      // Old format: parent_link: customfield_10301
      result[key] = {
        field_id: value,
        jql_name: defaults[key]?.jql_name || key.replace('_', ' '),
      };
    } else {
      // New format: parent_link: { field_id: ..., jql_name: ... }
      result[key] = {
        field_id: value.field_id || defaults[key]?.field_id,
        jql_name: value.jql_name || defaults[key]?.jql_name,
      };
    }
  }

  // Ensure we have both fields
  return { ...defaults, ...result };
}

/**
 * Get list of all configured hosts
 */
export function listHosts() {
  const config = loadConfig();
  return Object.entries(config.hosts || {}).map(([name, cfg]) => ({
    name,
    url: cfg.url,
    isDefault: name === config.default_host,
    syncPatterns: cfg.sync?.length || 0,
  }));
}

/**
 * Get the default host name
 */
export function getDefaultHost() {
  const config = loadConfig();
  return config.default_host;
}

/**
 * Get host name from a URL
 */
export function getHostNameFromUrl(url) {
  const config = loadConfig();
  for (const [name, cfg] of Object.entries(config.hosts || {})) {
    if (cfg.url === url || url?.includes(cfg.url)) {
      return name;
    }
  }
  return null;
}

/**
 * Get hierarchy fields config for a host URL
 * Returns { parent_link: { field_id, jql_name }, epic_link: { field_id, jql_name } }
 */
export function getHierarchyFieldsForUrl(url) {
  const config = loadConfig();
  for (const [, cfg] of Object.entries(config.hosts || {})) {
    if (cfg.url === url || url?.includes(cfg.url)) {
      return normalizeHierarchyFields(cfg.hierarchy_fields);
    }
  }
  // Return defaults if host not found
  return normalizeHierarchyFields(null);
}

/**
 * Clear cached config (useful for testing)
 */
export function clearCache() {
  cachedConfig = null;
  cachedTokens = null;
}
