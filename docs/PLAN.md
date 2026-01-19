# Jira CLI - Project Plan

A CLI tool that interacts with corporate Atlassian Jira Data Center installations using THE_PATTERN: offline-first architecture with local Markdown storage (list units with YAML frontmatter).

## Overview

### What is THE_PATTERN?

THE_PATTERN is an offline-first, "digital twin" architecture where:

1. **Online Mode**: Pull data from the remote service to local Markdown storage
2. **Offline Mode**: Query and manage the stored data locally without connectivity
3. **List Units**: Local `.md` files with YAML frontmatter containing metadata
4. **ID System**: Git-style short IDs (SHA1 hash) for easy reference

This pattern has been successfully implemented for:
- `outlook-email` - Microsoft O365 Outlook Email
- `slack-chat` - Slack messaging

Now we apply the same pattern to **Jira** — but with significant enhancements because **Jira tickets are fundamentally different** from emails and chat messages:

| Aspect | Email/Slack | Jira |
|--------|-------------|------|
| Lifecycle | Read once, archive | Revisited many times over weeks/months |
| Mutability | Immutable after send | Continuously evolving |
| Direction | Pull-only (read) | Full CRUD (read + write) |
| Versioning | None | Revision history matters |
| Volume | Sync everything | Selective sync (too many tickets to mirror all) |

### Three Unique Jira Concepts

1. **batch-style Bulk Create** — Define new tickets locally in YAML, push to remote
2. **Terraform-style Plan + Apply** — Edit offline, preview diff, apply to remote
3. **Re-entrant Pull** — Always safe to pull; preserves `offline:` key; upstream stays fast-forward compatible

**This gives us Offline-First CRUD** — not just read (as with Slack/Outlook).

### Technical Implementation

**Runtime & Language:**
- **Bun** JavaScript runtime
- ES6 modular syntax with `async/await`
- Minimize `node_modules/` dependencies — prefer Bun built-in/core modules
- **Exception**: Use `js-yaml` for YAML serialization (prefer multi-line YAML output)

**Code Constraints:**
- No file > 500 lines
- No function > 50 lines

---

## Typical Daily Workflow

### Morning Routine

```bash
# 1. Wake up, fetch latest ticket updates
jira pull

# 2. See what's new/changed since you last looked
jira list

# 3. View a specific ticket (shows diff by default)
jira view abc123

# 4. If you want full ticket content (not just diff)
jira view abc123 --full

# 5. Mark it as "read" (updates your last_read cursor)
jira mark abc123

# 6. Open ticket in VS Code for editing
jira open abc123

# 7. Or make quick edits via CLI (queued to offline)
jira edit abc123 status "In Progress"
jira comment abc123 "Looking into this now"

# 8. Preview what would be pushed to remote
jira plan

# 9. Apply your offline changes to remote Jira
jira apply
```

### Batch Ticket Creation 

```bash
# Create a YAML file with new tickets in any directory
cat > my-tasks.yaml << 'EOF'
epic:
  name: "Q1 Infrastructure Upgrade"
  summary: "Modernize auth system"
tasks:
  - summary: "Audit current LDAP config"
    description: "Review existing setup"
  - summary: "Design new auth flow"
    description: "Document proposed changes"
    depends_on: "Audit current LDAP config"
EOF

# Preview what would be created
jira batch my-tasks.yaml --plan

# Create the tickets in Jira
jira batch my-tasks.yaml --apply
```

### Key Workflow Principles

1. **Pull is always safe** — never loses local changes; `offline:` key is preserved
2. **Changes queue locally** — edits go to `offline.pending` until you `apply`
3. **Diff-first viewing** — `jira view` shows what changed since you last looked
4. **Selective sync** — only pull tickets matching your configured patterns (not the entire Jira instance)

---

## Jira Hosts

The company operates multiple Jira Data Center installations:

| Name | Base URL | Notes |
|------|----------|-------|
| Company | `https://jira.atlassian.company.com` | Primary/Main instance |
| Stage | `https://stage-jira.atlassian.company.com` | Staging/Test |

---

## CLI Help Text

```
jira - Offline-first Jira CLI with local Markdown storage

USAGE:
  jira <command> [options]

COMMANDS:
  pull          Fetch tickets from Jira to local storage
  list          List local tickets (changed since last read)
  view <id>     View ticket (diff by default, or --full)
  mark <id>     Mark ticket as read (or --clear to unmark)
  open <id>     Open ticket file in VS Code
  visit <id>    Open ticket permalink in browser
  edit <id>     Queue field changes (offline)
  comment <id>  Queue a comment (offline)
  link <id1> <id2>  Link two tickets in Jira
  delete <id>   Soft-delete ticket (queued for plan+apply)
  plan          Preview pending changes vs remote
  apply         Apply pending changes to remote
  batch <file>  Bulk create tickets from YAML 
  search <jql>  Search tickets with JQL (online, stdout)
  field         Custom field operations
  config        Manage hosts and sync patterns
  clean         Remove all ticket files from storage

Use "jira <command> --help" for more information about a command.
```

---

## Subcommands

### `jira pull`

**Purpose**: Fetch tickets from Jira and store locally as Markdown files.

**Behavior**:
- **Re-entrant**: Always safe to run; will overwrite remote data but **preserve the `offline:` key**
- **Selective**: Only fetches tickets matching patterns defined in `config.yaml`
- **Incremental**: Uses JQL `updated >=` filter based on last sync timestamp (not HTTP ETags, which Jira search doesn't support per-issue)

```
jira pull [--host <name>] [--full]

OPTIONS:
  --host <name>     Pull from specific host (default: all configured)
  --full            Ignore last_sync, pull everything fresh

EXAMPLES:
  jira pull                    # Pull from all hosts using sync patterns
  jira pull --host company    # Pull only from Company Jira
  jira pull --full             # Force full refresh
```

### `jira list`

**Purpose**: List local tickets that have changed since you last marked them read.

```
jira list [OPTIONS]

OPTIONS:
  -l, --limit <n>      Max results (default: 20)
  -s, --status <s>     Filter by status
  -p, --project <p>    Filter by project
  -h, --host <name>    Filter by host
  -a, --all            Include already-read tickets

OUTPUT FORMAT:
  <short_id> / <key> / <updated> / <status>
    <summary>
    [CHANGED: status, assignee, priority]  # Fields that changed

EXAMPLES:
  jira list                          # Show unread/changed tickets
  jira list --all                    # Show all local tickets
  jira list --project SRE --limit 50 # Filter by project
```

### `jira view`

**Purpose**: View a ticket. By default shows **diff** (what changed since last_read). 

```
jira view <id> [OPTIONS]

OPTIONS:
  --full              Show full current ticket (not diff)
  --revision <n>      Show specific revision from history
  --history           Show revision history summary

SUPPORTS:
  - Partial IDs: abc123
  - Full IDs: abc123def456...
  - Ticket keys: SRE-12345

EXAMPLES:
  jira view abc123             # Show diff since last read
  jira view SRE-12345 --full   # Show full current state
  jira view abc123 --history   # Show revision timeline
  jira view abc123 --revision 3 # Show specific past version
```

### `jira mark`

**Purpose**: Mark a ticket as read (updates `offline.last_read` timestamp), or clear the marker to mark as unread.

```
jira mark <id> [<id2> ...]
jira mark --clear <id>

OPTIONS:
  --all         Mark all tickets as read
  --clear, -c   Clear the last_read marker (mark as unread)

EXAMPLES:
  jira mark abc123              # Mark single ticket as read
  jira mark abc123 def456       # Mark multiple as read
  jira mark --all               # Mark all as read
  jira mark --clear abc123      # Clear last_read (mark as unread)
```

### `jira open`

**Purpose**: Open ticket file in VS Code.

```
jira open <id>

EXAMPLES:
  jira open abc123      # Opens storage/<hash>.md in VS Code
  jira open SRE-12345   # Same, resolves key to file
```

### `jira visit`

**Purpose**: Open ticket permalink URL in default browser.

```
jira visit <id>

EXAMPLES:
  jira visit abc123      # Opens ticket URL in browser
  jira visit SRE-12345   # Same, using Jira key
```

### `jira edit`

**Purpose**: Queue a field change (stored in `offline.pending` until `apply`).

```
jira edit <id> <field> <value>

EXAMPLES:
  jira edit abc123 status "In Progress"
  jira edit abc123 assignee "jdoe@company.com"
  jira edit abc123 priority High
  jira edit abc123 labels +urgent        # Add label
  jira edit abc123 labels -wontfix       # Remove label
```

### `jira comment`

**Purpose**: Queue a comment (stored in `offline.pending` until `apply`).

```
jira comment <id> <message>

EXAMPLES:
  jira comment abc123 "Working on this now"
  jira comment SRE-12345 "Blocked on upstream dependency"
```

### `jira link`

**Purpose**: Link two tickets in Jira with a relationship type.

```
jira link <id1> <id2> [--type <type>]

OPTIONS:
  --type, -t <type>   Link type (default: "Relates")
  --list              List available link types

COMMON LINK TYPES:
  Relates             Generic relationship (default)
  Blocks              id1 blocks id2
  Dependency          id1 is depended on by id2
  Duplicate           id1 duplicates id2

EXAMPLES:
  jira link abc123 def456                    # Relates abc123 to def456
  jira link SRE-123 SRE-456 --type Blocks    # SRE-123 blocks SRE-456
  jira link abc123 def456 -t Dependency      # abc123 is depended on by def456
```

### `jira plan`

**Purpose**: Preview pending changes vs current remote state (Terraform-style).

```
jira plan [--host <name>]

OUTPUT:
  Planned changes:

  ~ SRE-12345 (abc123)
    status:   "Open" → "In Progress"
    assignee: null → "jdoe@company.com"
    + comment: "Working on this now"

  ~ SRE-12346 (def456)
    priority: "Low" → "High"

  Plan: 2 tickets to update, 0 to create
```

### `jira apply`

**Purpose**: Apply pending changes to remote Jira.

```
jira apply [--yes] [--host <name>]

OPTIONS:
  --yes           Skip confirmation prompt
  --host <name>   Only apply changes for specific host

EXAMPLES:
  jira apply           # Interactive confirmation
  jira apply --yes     # Auto-confirm (for scripts)
```

### `jira batch`

**Purpose**: Bulk create tickets from YAML file (batch-style, offline-first).

```
jira batch <file> [OPTIONS]

OPTIONS:
  --plan          Preview what would be created (dry-run)
  --apply         Actually create the tickets
  --host <name>   Target host (default: from config or file)
  --config <file> batch config file for defaults

EXAMPLES:
  jira batch tasks.yaml --plan     # Preview
  jira batch tasks.yaml --apply    # Create tickets
```

**YAML Schema** (batch-compatible):

```yaml
# Optional: config overrides
common:
  project:
    id: 18401
    name: SRE
  labels: ["my-project"]
  assigned_group: ".SRE - Team"
  default_issue_type: Task

# Optional: parent epic
epic:
  name: "Epic Title"
  summary: "Epic summary"
  # OR use existing:
  id: "SRE-12345"

# Required: tasks to create
tasks:
  - summary: "First task"
    description: "Task details"
    story_points: 3
  - summary: "Second task"
    description: "Depends on first"
    depends_on: "First task"
```

### `jira search`

**Purpose**: Search tickets with JQL (online, outputs to stdout). Pure JQL passthrough — no local parsing.

```
jira search <jql> [OPTIONS]

OPTIONS:
  --host <name>       Jira host (default: company)
  --limit <n>         Max results (default: 50)
  --fields <list>     Comma-separated field list
  --format <fmt>      Output format: table, yaml, json (default: table)

EXAMPLES:
  jira search "project = SRE AND status = Open"
  jira search "assignee = currentUser() ORDER BY updated DESC" --limit 10
  jira search "project = SRE" --fields key,summary,status --format yaml
```

### `jira field`

**Purpose**: Custom field operations (sync field definitions, lookup IDs).

```
jira field <subcommand>

SUBCOMMANDS:
  sync              Pull field definitions from remote to cache
  list              List cached custom fields
  get <id>          Get field details by ID
  find <name>       Search fields by name

EXAMPLES:
  jira field sync --host company     # Refresh field cache
  jira field list                     # Show all fields
  jira field find "assigned group"    # Search by name
  jira field get customfield_10314    # Get specific field
```

### `jira config`

**Purpose**: Manage configuration (hosts, sync patterns).

```
jira config <subcommand>

SUBCOMMANDS:
  show              Show current configuration
  hosts             List configured hosts
  patterns          Show sync patterns per host
  edit              Open config.yaml in editor

EXAMPLES:
  jira config show
  jira config hosts
  jira config patterns --host company
```

### `jira delete`

**Purpose**: Soft-delete a ticket locally. The deletion is queued and applied to remote Jira with `jira apply`.

```
jira delete <id>
jira delete --clear <id>

OPTIONS:
  --clear, -c   Undo soft-delete (remove deletion marker)

EXAMPLES:
  jira delete abc123           # Mark for deletion
  jira delete --clear abc123   # Undo deletion marker
```

### `jira clean`

**Purpose**: Remove all ticket files from local storage. Useful for starting fresh. Data can be recovered by running `jira pull`.

```
jira clean

EXAMPLES:
  jira clean    # Remove all ticket files
```

---

## Storage Format

Each ticket is stored as a Markdown file in `storage/` with YAML frontmatter:

```markdown
---
key: SRE-12345
id: '123456'
host: jira.atlassian.company.com
summary: Fix login authentication issue
status:
  name: In Progress
  id: '3'
priority:
  name: High
  id: '2'
issuetype:
  name: Bug
  id: '1'
assignee:
  displayName: John Doe
  emailAddress: jdoe@company.com
reporter:
  displayName: Jane Smith
  emailAddress: jsmith@company.com
project:
  key: SRE
  name: Site Reliability Engineering
created: '2026-01-15T10:30:00.000Z'
updated: '2026-01-18T14:22:00.000Z'
labels:
  - production
  - urgent
components:
  - name: Authentication
webLink: https://jira.atlassian.company.com/browse/SRE-12345
_stored_id: 6498cec18d676f08ff64932bf93e7ec33c0adb2b
_stored_at: '2026-01-19T09:00:00.000Z'
_etag: 'W/"abc123"'
offline:
  last_read: '2026-01-18T10:00:00.000Z'
  last_sync: '2026-01-19T09:00:00.000Z'
  previous:                              # Snapshot at last_read for diffing
    status:
      name: Open
    assignee: null
  pending:                               # Queued changes (not yet applied)
    status: In Progress
    comments:
      - text: "Working on this now"
        queued_at: '2026-01-19T09:30:00.000Z'
  tags:                                  # Local-only tags
    - needs-review
---

# SRE-12345: Fix login authentication issue

**Status:** In Progress
**Priority:** High
**Assignee:** John Doe
**Reporter:** Jane Smith
**Project:** Site Reliability Engineering (SRE)
**Created:** 2026-01-15
**Updated:** 2026-01-18
**Link:** [SRE-12345](https://jira.atlassian.company.com/browse/SRE-12345)

---

## Description

Users are experiencing intermittent login failures when attempting
to authenticate via LDAP. The issue appears to be related to...

---

## Comments

### Jane Smith (2026-01-15 10:35)
Created this ticket to track the authentication issues reported by users.

### John Doe (2026-01-16 09:00)
Investigating. Initial analysis suggests a timeout issue with the LDAP server.
```

---

## Core Concepts

### ID System (Git-style)

- **Jira Key**: `SRE-12345` (human-readable ticket identifier)
- **SHA1 Hash**: 40-character hex hash of `host:key`, used as filename
- **Short ID**: First 6 characters of hash (e.g., `6498ce`)

All CLI commands support partial ID matching:

```bash
# These all refer to the same ticket:
jira view 6498cec18d676f08ff64932bf93e7ec33c0adb2b  # Full hash
jira view 6498ce                                     # Short ID
jira view SRE-12345                                  # Jira key
```

### Offline Metadata (`offline:` key)

The `offline` section is **never pushed to remote** and is **preserved during pull**. It contains:

```yaml
offline:
  # Cursor tracking
  last_read: '2026-01-18T10:00:00.000Z'   # When you last viewed this ticket
  last_sync: '2026-01-19T09:00:00.000Z'   # When we last pulled from remote

  # For diffing (snapshot at last_read)
  previous:
    status:
      name: Open
    assignee: null
    priority:
      name: Low

  # Queued changes (for plan/apply)
  pending:
    status: In Progress
    assignee: jdoe@company.com
    comments:
      - text: "Working on this now"
        queued_at: '2026-01-19T09:30:00.000Z'
    transition: "Start Progress"  # If status change requires transition

  # Local-only metadata
  tags:
    - needs-review
    - blocked
```

### Re-entrant Pull Behavior

When `jira pull` runs:

1. Fetch ticket data from remote
2. If local file exists:
   - Read existing `offline:` key
   - Overwrite entire file with new remote data
   - Restore `offline:` key (merge back in)
3. If local file doesn't exist:
   - Write new file with empty `offline:` section
4. Update `offline.last_sync` timestamp

**This ensures:**
- Upstream changes always flow in (fast-forward compatible)
- Local offline state is never lost
- Pending changes are preserved until applied

---

## Configuration

### `config.yaml` — Host Definitions & Sync Patterns

```yaml
# config.yaml
default_host: company

hosts:
  company:
    url: https://jira.atlassian.company.com
    api: /rest/api/2
    # Sync patterns: hierarchical filter for what to pull
    sync:
      # Pattern 1: All my assigned tickets
      - jql: "assignee = currentUser() AND updated >= -30d"
      # Pattern 2: Specific projects I care about
      - project: SRE
        jql: "status != Closed AND updated >= -14d"
      # Pattern 3: Tickets I'm watching
      - jql: "watcher = currentUser()"

stage:
    url: https://stage-jira.atlassian.company.com
    api: /rest/api/2
    sync: []  # No automatic sync for staging
```

### `.tokens.yaml` — Authentication (gitignored)

```yaml
# .tokens.yaml (DO NOT COMMIT)
hosts:
  company:
    token: <PAT_TOKEN>
  stage:
    token: <PAT_TOKEN>
```

### Project Structure

```
jira/
├── config.yaml            # Host definitions + sync patterns (committed)
├── .tokens.yaml           # API tokens (gitignored)
├── .tokens.yaml.example   # Token file template
├── package.json           # Project config
├── README.md              # User documentation
├── SKILL.md               # AI agent documentation
├── docs/
│   └── PLAN.md            # This file
├── src/
│   ├── cli.mjs            # Main CLI entrypoint
│   ├── commands/
│   │   ├── pull.mjs       # Pull command
│   │   ├── list.mjs       # List command
│   │   ├── view.mjs       # View command (with diff)
│   │   ├── mark.mjs       # Mark as read
│   │   ├── open.mjs       # Open in editor
│   │   ├── edit.mjs       # Queue edits
│   │   ├── comment.mjs    # Queue comments
│   │   ├── plan.mjs       # Preview changes
│   │   ├── apply.mjs      # Apply changes
│   │   ├── batch.mjs      # Bulk create (batch)
│   │   ├── search.mjs     # JQL search
│   │   ├── field.mjs      # Field operations
│   │   └── config.mjs     # Config management
│   ├── lib/
│   │   ├── api.mjs        # Jira REST API client
│   │   ├── storage.mjs    # Local storage operations
│   │   ├── hosts.mjs      # Multi-host configuration
│   │   ├── id.mjs         # ID resolution utilities
│   │   ├── diff.mjs       # Ticket diff generation
│   │   └── batch.mjs     # Batch creation logic
│   └── index.mjs          # Library exports
└── storage/               # Local ticket storage
    ├── _cache/            # Cached metadata
    │   ├── fields/        # Field definitions per host
    │   │   ├── company.yaml
    
    │   └── projects/      # Project metadata per host
    └── *.md               # Ticket files (named by SHA1 hash)
```

---

## Implementation Notes

### API Reference

- Jira REST API v2: https://docs.atlassian.com/software/jira/docs/api/REST/8.20.14/
- PAT Authentication: `Authorization: Bearer <token>`
- Base endpoint: `https://{host}/rest/api/2/{resource}`

### Key Endpoints

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Get Issue | GET | `/rest/api/2/issue/{issueIdOrKey}` |
| Search | POST | `/rest/api/2/search` |
| Create Issue | POST | `/rest/api/2/issue` |
| Update Issue | PUT | `/rest/api/2/issue/{issueIdOrKey}` |
| Transitions | GET | `/rest/api/2/issue/{issueIdOrKey}/transitions` |
| Do Transition | POST | `/rest/api/2/issue/{issueIdOrKey}/transitions` |
| Add Comment | POST | `/rest/api/2/issue/{issueIdOrKey}/comment` |
| Get Fields | GET | `/rest/api/2/field` |

### JQL Notes

- JQL is passed through 1:1 to the API — no local parsing or augmentation
- This ensures predictable behavior matching Jira's native JQL support

---

## Documentation Strategy

We maintain a single-source-of-truth approach for documentation:

### Help Text (Authoritative)

The CLI `--help` output is the **authoritative source** for command usage:
- `jira --help` — lists all commands
- `jira <command> --help` — detailed usage for each command

Help text lives in each command file as `const HELP = ...` and includes:
- Usage syntax
- Options and flags
- Examples
- Behavior notes (where relevant)

### SKILL.md (AI Agent Overview)

Points to `--help` rather than duplicating content:
- Quick command reference table with "Help" column
- High-level concepts (ID system, offline workflow)
- Links to `.example` files for schemas
- Error handling guidance for agents

### README.md (User Quick Start)

Brief user-facing documentation:
- Installation steps
- Quick usage examples
- Links to SKILL.md for details

### Example Files (Schema Documentation)

Well-commented `.example` files serve as schema documentation:
- `config.yaml.example` — host configuration schema
- `.tokens.yaml.example` — authentication setup
- `batch.yaml.example` — batch ticket creation schema
- `storage/ticket.md.example` — ticket storage format
