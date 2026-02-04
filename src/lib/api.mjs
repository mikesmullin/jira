/**
 * Jira REST API client
 * Handles HTTP requests to Jira with PAT authentication
 */

import { getHostConfig } from './config.mjs';

/**
 * Make an authenticated request to Jira API
 */
async function request(hostName, method, endpoint, body = null) {
  const host = getHostConfig(hostName);
  const url = `${host.url}${host.api}${endpoint}`;

  const headers = {
    'Authorization': `Bearer ${host.token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira API error ${response.status}: ${text}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/**
 * GET request helper
 */
export async function get(hostName, endpoint) {
  return request(hostName, 'GET', endpoint);
}

/**
 * POST request helper
 */
export async function post(hostName, endpoint, body) {
  return request(hostName, 'POST', endpoint, body);
}

/**
 * PUT request helper
 */
export async function put(hostName, endpoint, body) {
  return request(hostName, 'PUT', endpoint, body);
}

/**
 * Get a single issue by key
 */
export async function getIssue(hostName, issueKey, fields = null) {
  let endpoint = `/issue/${issueKey}`;
  if (fields) {
    endpoint += `?fields=${fields.join(',')}`;
  }
  return get(hostName, endpoint);
}

/**
 * Search issues with JQL
 */
export async function search(hostName, jql, options = {}) {
  const { maxResults = 50, startAt = 0, fields = null } = options;

  const body = {
    jql,
    maxResults,
    startAt,
  };

  if (fields) {
    body.fields = fields;
  }

  return post(hostName, '/search', body);
}

/**
 * Search all issues matching JQL (handles pagination)
 */
export async function searchAll(hostName, jql, options = {}) {
  const { fields = null, maxResults = 100, limit = null } = options;
  const allIssues = [];
  let startAt = 0;

  while (true) {
    // If we have a limit, don't fetch more than needed
    const fetchSize = limit ? Math.min(maxResults, limit - allIssues.length) : maxResults;
    
    const result = await search(hostName, jql, {
      maxResults: fetchSize,
      startAt,
      fields,
    });

    allIssues.push(...result.issues);

    // Stop if we've hit our limit
    if (limit && allIssues.length >= limit) {
      break;
    }

    if (startAt + result.issues.length >= result.total) {
      break;
    }

    startAt += result.issues.length;
  }

  return limit ? allIssues.slice(0, limit) : allIssues;
}

/**
 * Create a new issue
 */
export async function createIssue(hostName, issueData) {
  return post(hostName, '/issue', issueData);
}

/**
 * Update an existing issue
 */
export async function updateIssue(hostName, issueKey, fields) {
  return put(hostName, `/issue/${issueKey}`, { fields });
}

/**
 * Delete an issue
 */
export async function deleteIssue(hostName, issueKey) {
  return request(hostName, 'DELETE', `/issue/${issueKey}`);
}

/**
 * Create a link between two issues
 */
export async function createLink(hostName, linkData) {
  return post(hostName, '/issueLink', linkData);
}

/**
 * Delete a link between issues by link ID
 */
export async function deleteLink(hostName, linkId) {
  return request(hostName, 'DELETE', `/issueLink/${linkId}`);
}

/**
 * Get all links for an issue (from issue fields)
 */
export async function getIssueLinks(hostName, issueKey) {
  const issue = await get(hostName, `/issue/${issueKey}?fields=issuelinks`);
  return issue.fields?.issuelinks || [];
}

/**
 * Get available transitions for an issue
 */
export async function getTransitions(hostName, issueKey) {
  return get(hostName, `/issue/${issueKey}/transitions`);
}

/**
 * Perform a transition on an issue
 */
export async function doTransition(hostName, issueKey, transitionId) {
  return post(hostName, `/issue/${issueKey}/transitions`, {
    transition: { id: transitionId },
  });
}

/**
 * Add a comment to an issue
 */
export async function addComment(hostName, issueKey, body) {
  return post(hostName, `/issue/${issueKey}/comment`, { body });
}

/**
 * Get comments for an issue
 */
export async function getComments(hostName, issueKey) {
  const result = await get(hostName, `/issue/${issueKey}/comment`);
  return result.comments || [];
}

/**
 * Get all fields (for custom field mapping)
 */
export async function getFields(hostName) {
  return get(hostName, '/field');
}

/**
 * Make an authenticated request to Insight REST API (for Assets/Insight fields)
 * Uses /rest/insight/1.0 base path instead of /rest/api/2
 */
async function insightRequest(hostName, method, endpoint) {
  const host = getHostConfig(hostName);
  const url = `${host.url}/rest/insight/1.0${endpoint}`;

  const headers = {
    'Authorization': `Bearer ${host.token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const response = await fetch(url, { method, headers });

  if (!response.ok) {
    return null; // Insight API may not be available
  }

  return response.json();
}

/**
 * Search Insight objects using IQL (Insight Query Language)
 * @param {string} hostName - Jira host name
 * @param {string} iql - IQL query (e.g., 'Name like "StarCraft"')
 * @param {number} maxResults - Maximum results to return
 * @returns {Array} Array of matching objects with objectKey and label
 */
export async function searchInsightObjects(hostName, iql, maxResults = 50) {
  const encoded = encodeURIComponent(iql);
  const result = await insightRequest(
    hostName,
    'GET',
    `/iql/objects?iql=${encoded}&resultPerPage=${maxResults}`
  );
  
  if (!result?.objectEntries) {
    return [];
  }
  
  return result.objectEntries.map(obj => ({
    key: obj.objectKey,
    label: obj.label,
    id: obj.id,
    objectType: obj.objectType?.name
  }));
}

/**
 * Get Insight object schemas (top-level categories like CMDB)
 */
export async function getInsightSchemas(hostName) {
  const result = await insightRequest(hostName, 'GET', '/objectschema/list');
  return result?.objectschemas || [];
}

/**
 * Get object types within a schema (e.g., Service, Hardware, Host)
 */
export async function getInsightObjectTypes(hostName, schemaId) {
  const result = await insightRequest(hostName, 'GET', `/objectschema/${schemaId}/objecttypes/flat`);
  return Array.isArray(result) ? result : [];
}

/**
 * Get allowed values for a field using createmeta v2 API
 * Works for standard select/multiselect fields
 */
export async function getFieldOptions(hostName, projectKey, issueType, fieldId) {
  // First get issue types to find the type ID
  const typesResult = await get(hostName, `/issue/createmeta/${projectKey}/issuetypes`);
  const issueTypeObj = typesResult.values?.find(t => 
    t.name.toLowerCase() === issueType.toLowerCase()
  );
  
  if (!issueTypeObj) {
    const available = typesResult.values?.map(t => t.name).join(', ');
    throw new Error(`Issue type "${issueType}" not found. Available: ${available}`);
  }
  
  // Get fields for this issue type
  const fieldsResult = await get(hostName, `/issue/createmeta/${projectKey}/issuetypes/${issueTypeObj.id}`);
  
  // Find our field (may need to paginate for large field sets)
  let field = fieldsResult.values?.find(f => f.fieldId === fieldId);
  
  // If not found in first page and there are more, try to get all
  if (!field && fieldsResult.total > fieldsResult.values?.length) {
    // Fetch all fields
    let startAt = fieldsResult.values?.length || 0;
    while (startAt < fieldsResult.total) {
      const moreFields = await get(hostName, 
        `/issue/createmeta/${projectKey}/issuetypes/${issueTypeObj.id}?startAt=${startAt}`
      );
      field = moreFields.values?.find(f => f.fieldId === fieldId);
      if (field) break;
      startAt += moreFields.values?.length || 50;
    }
  }
  
  return field?.allowedValues || [];
}

/**
 * Get all issue link types
 */
export async function getLinkTypes(hostName) {
  const result = await get(hostName, '/issueLinkType');
  return result.issueLinkTypes || [];
}

/**
 * Get changelog (revision history) for an issue
 * Note: On Jira Data Center, changelog is accessed via expand parameter
 */
export async function getChangelog(hostName, issueKey) {
  const result = await get(hostName, `/issue/${issueKey}?expand=changelog`);
  return result.changelog || { histories: [] };
}

/**
 * Test connection to a host
 */
export async function testConnection(hostName) {
  try {
    await get(hostName, '/myself');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
