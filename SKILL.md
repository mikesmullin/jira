# Jira CLI - AI Agent Documentation

This document provides AI agents with an overview of the Jira CLI tool. For detailed usage, run `jira --help` or `jira <subcommand> --help`.

## Overview

The Jira CLI follows the pattern of an offline-first architecture with local Markdown (YAML frontmatter storage) flat-file database.

- **Pull** tickets from remote → local Markdown files
- **Work offline** with queued edits and comments  
- **Push** changes with plan/apply workflow
- **Batch create** tickets from YAML 

## Commands

| Command | Purpose | Help |
|---------|---------|------|
| `pull` | Fetch tickets to local storage | `jira pull --help` |
| `list` | List local tickets | `jira list --help` |
| `view <id>` | View ticket (diff/full) | `jira view --help` |
| `mark <id>` | Mark as read (or `--clear` to unmark) | `jira mark --help` |
| `open <id>` | Open in VS Code | `jira open --help` |
| `visit <id>` | Open in browser | `jira visit --help` |
| `edit <id>` | Queue field changes | `jira edit --help` |
| `comment <id>` | Queue a comment | `jira comment --help` |
| `link <id1> <id2>` | Link two tickets | `jira link --help` |
| `delete <id>` | Soft-delete (or `--clear` to undo) | `jira delete --help` |
| `plan` | Preview pending changes | `jira plan --help` |
| `apply` | Push changes to remote | `jira apply --help` |
| `batch <file>` | Bulk create from YAML | `jira batch --help` |
| `search <jql>` | JQL search (online) | `jira search --help` |
| `field` | Field operations | `jira field --help` |
| `config` | Configuration management | `jira config --help` |
| `clean` | Remove all local ticket files | `jira clean --help` |

## ID System

All commands accept three ID formats interchangeably:
- **Jira Key**: `SRE-12345`
- **Short ID**: `abc123` (first 6 chars of SHA1)
- **Full ID**: `abc123def456...` (40-char SHA1)

## Key Concepts

### Offline-First Workflow

```bash
jira pull                              # Fetch from remote
jira edit abc123 status "In Progress"  # Queued locally
jira comment abc123 "Working on it"    # Queued locally
jira plan                              # Preview diff
jira apply                             # Push to remote
```

### Re-entrant Pull

`jira pull` is always safe — it preserves the `offline:` key in local storage, so pending edits are never lost. See `jira pull --help`.

### Batch Creation

Create multiple tickets from YAML. See [batch.yaml.example](batch.yaml.example) for full schema or `jira batch --help`.

```bash
jira batch tasks.yaml --plan   # Preview
jira batch tasks.yaml --apply  # Create
```

## Configuration

Configuration files are YAML-based. See the `.example` files for full schema documentation:

| File | Purpose | Example |
|------|---------|---------|
| `config.yaml` | Hosts and sync patterns | [config.yaml.example](config.yaml.example) |
| `.tokens.yaml` | Authentication (gitignored) | [.tokens.yaml.example](.tokens.yaml.example) |
| `*.yaml` (batch) | Bulk ticket creation | [batch.yaml.example](batch.yaml.example) |

### Quick Setup

```bash
cp config.yaml.example config.yaml      # Edit hosts and sync patterns
cp .tokens.yaml.example .tokens.yaml    # Add your PAT tokens
jira field sync --host company         # Cache custom field IDs
```

## Storage Format

Tickets are stored in `storage/` as Markdown files with YAML frontmatter. The `offline:` key holds local state (pending edits, last_read cursor) and is preserved during pull.

See [storage/ticket.md.example](storage/ticket.md.example) for the full annotated schema.

Key sections:
- **Jira metadata** — `key`, `status`, `assignee`, `description`, etc. (from remote)
- **`offline.last_read`** — When you last viewed this ticket
- **`offline.previous`** — Snapshot for diff display
- **`offline.pending`** — Queued edits/comments (applied with `jira apply`)

## Error Handling

- CLI throws on missing config/tokens with clear error messages
- Exits with non-zero code on failure
- AI agents should check exit codes and retry transient network failures
