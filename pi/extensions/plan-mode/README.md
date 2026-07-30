# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Built-in write tools disabled**: Disables edit/write while preserving other active tools
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Approved execution handoff**: Returns the numbered plan to the parent agent with full tool access
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan / auto mode
- `Shift+Tab` - Toggle plan / auto mode (shortcut)

## Usage

1. Enable plan mode with `/plan`, `Shift+Tab`, or the `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted
5. The parent agent receives the approved steps with full tool access
6. Execution mode ends when that agent run settles

## How It Works

### Plan Mode (Read-Only)

- Built-in edit/write tools disabled
- Other active tools remain available
- Bash commands filtered through allowlist
- Agent creates a plan without making changes

### Execution Mode

- Full tool access restored
- Approved plan steps are returned to the parent agent
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
