# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Built-in write tools disabled**: Disables edit/write while preserving other active tools
- **Bash allowlist**: Only read-only bash commands are allowed
- **Foreman planning workflow**: Loads the active `foreman-plan` skill for proportional discovery, separate design and plan approvals, and high-fidelity validation
- **Plan extraction**: Extracts the final numbered execution summary from `Plan:` sections
- **Approved execution handoff**: Returns the complete approved plan to the parent agent with full tool access
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan / auto mode
- `Shift+Tab` - Toggle plan / auto mode (shortcut)

## Usage

1. Enable plan mode with `/plan`, `Shift+Tab`, or the `--plan` flag
2. Ask the agent to analyze a change
3. The agent follows the active `foreman-plan` skill to inspect, clarify, and obtain design approval
4. After design approval, separately confirm that the implementation plan should be created
5. The agent returns the validated plan in chat and concludes with a numbered `Plan:` execution summary
6. Choose "Execute the plan" when prompted
7. The parent agent receives the complete approved plan with full tool access
8. Execution mode ends when that agent run settles

## How It Works

### Plan Mode (Read-Only)

- Built-in edit/write tools disabled
- Other active tools remain available
- Bash commands filtered through allowlist
- Active `foreman-plan` guidance is injected from Pi's discovered skill metadata, followed by a Pi-specific read-only delivery contract that keeps the plan in chat and ends it with a numbered `Plan:` summary
- The current plan/build mode is reasserted as authoritative guidance after transitions and lifecycle boundaries so stale planning history cannot disable execution
- Missing or unreadable guidance produces a warning and uses a safe approval-gated fallback
- The plan remains in chat so repository files are not changed

### Execution Mode

- Full tool access restored
- The complete approved plan is returned to the parent agent
- The parent executes steps in order using its available task-management capabilities
- Execution mode ends independently when the agent run settles

### Command Allowlist

Safe commands (allowed):

- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:

- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
