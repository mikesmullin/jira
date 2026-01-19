/**
 * Configuration management for Jira CLI
 * Loads config.yaml and .tokens.yaml
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..', '..');

let cachedConfig = null;
let cachedTokens = null;

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
 * Load and parse .tokens.yaml
 */
export function loadTokens() {
  if (cachedTokens) return cachedTokens;

  const tokensPath = join(ROOT_DIR, '.tokens.yaml');
  if (!existsSync(tokensPath)) {
    throw new Error(
      `Tokens file not found: ${tokensPath}\n` +
      `Copy .tokens.yaml.example to .tokens.yaml and add your PATs`
    );
  }

  const content = readFileSync(tokensPath, 'utf8');
  cachedTokens = yaml.load(content);
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
    throw new Error(`No valid token configured for host: ${name}`);
  }

  return {
    name,
    url: hostConfig.url,
    api: hostConfig.api || '/rest/api/2',
    token,
    sync: hostConfig.sync || [],
  };
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
 * Clear cached config (useful for testing)
 */
export function clearCache() {
  cachedConfig = null;
  cachedTokens = null;
}
