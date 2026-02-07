# Jira CLI

Offline-first Jira CLI with local Markdown storage.

## Features

- **Offline-first**: Pull tickets to local storage, work offline, push changes when ready
- **Markdown storage**: Tickets stored as `.md` files with YAML frontmatter
- **Git-style IDs**: Short SHA1 hashes for easy reference (e.g., `abc123`)
- **Multi-host support**: Connect to multiple Jira Data Center instances
- **Terraform-style workflow**: `plan` to preview, `apply` to push changes

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- Personal Access Token (PAT) for each Jira host

## Installation

```bash
# Install dependencies
bun install

# Link globally
bun link
```

## Configuration

1. Copy the tokens example file:
```bash
cp .tokens.yaml.example .tokens.yaml
```

2. Add your Personal Access Tokens to `.tokens.yaml`

3. Edit `config.yaml` to configure hosts and sync patterns

## Usage

```bash
# Fetch tickets from configured hosts
jira pull

# List unread/changed tickets
jira list

# View a ticket (shows diff by default)
jira view SRE-12345
jira view abc123 --full

# Mark as read
jira mark abc123

# Open ticket file in VS Code
jira open abc123

# Open ticket permalink in browser
jira visit abc123

# Queue edits (offline)
jira edit abc123 status "In Progress"
jira comment abc123 "Working on this"

# Link two tickets
jira link abc123 def456

# Soft-delete a ticket (queued for plan+apply)
jira delete abc123

# Preview and apply changes
jira plan
jira apply

# Bulk create tickets from YAML
jira batch tickets.yaml

# Search with JQL (online)
jira search "project = SRE AND status = Open"

# Manage fields cache
jira field sync --host company
jira field find "assigned group"

# Manage hosts and sync patterns
jira config

# Remove all ticket files from storage
jira clean
```

### Batch File Example

Create multiple tickets at once with a YAML file:

```yaml
# tickets.yaml
epic:
  name: "Q1 Infrastructure Upgrade"
  description: "Modernize authentication systems"

common:
  project:
    id: 17500
    name: SRE
  labels: ["q1-2026"]
  assigned_group: ".SRE - Team"
  default_issue_type: Task

tasks:
  - summary: "Audit current LDAP configuration"
    description: "Review existing authentication setup."

  - summary: "Design new authentication flow"
    issue_type: Story
    story_points: 5
    labels: ["design"]
    links:
      - depends_on: "Audit current LDAP configuration"

  - summary: "Implement OAuth2 integration"
    story_points: 8
    links:
      - depends_on: "Design new authentication flow"
```

```bash
jira batch tickets.yaml --plan   # Preview what would be created
jira batch tickets.yaml --apply  # Create the tickets
```

See [batch.yaml.example](batch.yaml.example) for the full schema.

## Storage

Tickets are stored in `storage/` as Markdown files:

```
storage/
├── _cache/           # Cached metadata
│   └── fields/       # Custom field definitions
└── abc123def456...md # Ticket files
```

Each ticket has YAML frontmatter with metadata and an `offline:` section for local state.