# Hokusai Workflow Plugin for Claude Code

A comprehensive workflow automation plugin for implementing features in Hokusai projects using Linear integration and structured development processes.

## Features

- **Linear Integration**: Fetch and manage tasks directly from Linear backlog
- **Automated Workflow**: Structured 8-step feature implementation process
- **Knowledge Management**: Build and maintain cumulative codebase knowledge
- **PRD Generation**: AI-assisted Product Requirements Document creation
- **Task Breakdown**: Convert PRDs into actionable development tasks
- **Test-Driven Development**: Built-in TDD workflow with fast feedback loops
- **Git Integration**: Automated branching and PR creation
- **Custom Agents**: Specialized AI agents for investigation, flow mapping, and documentation

## Installation

### Prerequisites

- Claude Code (>= 1.0.0)
- Node.js (>= 18.0.0)
- npm (>= 8.0.0)
- Git
- GitHub CLI (`gh`)
- Linear API access

### Setup

1. Clone or download this plugin to your preferred location:
```bash
git clone https://github.com/yourusername/claude-hokusai-workflow-plugin.git
cd claude-hokusai-workflow-plugin
```

2. Install tool dependencies:
```bash
npm install --prefix tools
```

3. Copy the plugin files to your `~/.claude` directory:
```bash
# Copy tools
cp -r tools/* ~/.claude/tools/

# Copy agents
cp -r agents/* ~/.claude/agents/

# Copy prompts
cp prompts/my-common-prompts.md ~/.claude/
```

4. Configure environment variables:
```bash
# Create .env file in tools directory
cp .env.example tools/.env

# Edit tools/.env and add your credentials:
# LINEAR_API_KEY=your_linear_api_key_here
# GITHUB_TOKEN=your_github_token_here (optional, if not using gh CLI)
```

5. Get your Linear API key:
   - Go to [Linear Settings > API](https://linear.app/settings/api)
   - Generate a new API key
   - Add it to `tools/.env`

6. Update your Claude Code settings:
   - Add the custom command configuration from `plugin.json` to your `~/.claude/settings.json`

## Usage

### Quick Start

1. In any Hokusai project repository, reference the workflow prompts:
```markdown
<!-- In your project's CLAUDE.md -->
# Common Commands
@~/.claude/my-common-prompts.md
```

2. Start the workflow:
```bash
/workflow
```

3. Or manually fetch Linear backlog:
```bash
npx tsx ~/.claude/tools/get-backlog.ts "Project Name"
```

### Workflow Steps

The plugin implements an 8-step feature development process:

1. **Select Task**: Fetch and select from Linear backlog
2. **Create Branch**: Automated git branch creation
3. **Generate PRD**: AI-assisted requirements documentation with knowledge management
4. **Generate Tasks**: Break PRD into actionable development tasks
5. **Implement with TDD**: Test-first development with fast feedback loops
6. **Open PR**: Automated pull request creation
7. **Review Checklist**: Ensure quality gates are met
8. **Knowledge Extraction**: Update codebase knowledge map

### Available Tools

- `get-backlog.ts`: Fetch Linear tasks in "Backlog" state
- `github.ts`: Automated Git and GitHub operations
- Prompt templates in `tools/prompts/`:
  - `prd-prompt-template.md`: PRD generation
  - `tasks-prompt-template.md`: Task breakdown
  - `bug-workflow-prompt.md`: Bug investigation workflow
  - `plan-workflow-prompt.md`: Planning workflow

### Custom Agents

The plugin includes specialized agents:

- **project-investigator**: Analyze codebase and identify relevant files
- **flow-mapper**: Map data flows and component interactions
- **prd-writer**: Generate comprehensive PRDs
- **agent-assignment-expert**: Route tasks to appropriate agents
- **api-architect**: Design API structures
- **backend-developer**: Backend implementation
- **frontend-developer**: Frontend implementation
- **blockchain-infrastructure-expert**: Blockchain-specific tasks
- **redis-queue-expert**: Redis queue implementation

## Project Structure

```
claude-hokusai-workflow-plugin/
├── README.md                          # This file
├── plugin.json                        # Plugin metadata
├── .env.example                       # Environment variables template
├── prompts/
│   └── my-common-prompts.md          # Workflow documentation
├── tools/
│   ├── package.json                   # Tool dependencies
│   ├── get-backlog.ts                # Linear integration
│   ├── github.ts                      # GitHub integration
│   └── prompts/                       # Template files
│       ├── prd-prompt-template.md
│       ├── tasks-prompt-template.md
│       ├── bug-workflow-prompt.md
│       └── plan-workflow-prompt.md
└── agents/
    ├── project-investigator.md
    ├── flow-mapper.md
    ├── prd-writer.md
    └── ...
```

## Configuration

### Per-Project Setup

Add to your project's `CLAUDE.md`:

```markdown
# Common Commands
@~/.claude/my-common-prompts.md

# Project Configuration
For this repo, use the "[Your Project Name]" project in Linear to pull the backlog list.
```

### Custom Workflow Modifications

You can customize the workflow by:

1. Editing prompt templates in `tools/prompts/`
2. Modifying agent definitions in `agents/`
3. Adjusting the workflow steps in `prompts/my-common-prompts.md`

## Troubleshooting

### Linear API Issues

If Linear integration fails:
```bash
# Test your API connection
npx tsx ~/.claude/tools/get-backlog.ts "Test"

# Check your .env file has LINEAR_API_KEY set
cat tools/.env
```

### GitHub CLI Issues

```bash
# Verify gh CLI is installed and authenticated
gh --version
gh auth status

# Re-authenticate if needed
gh auth login
```

### Tool Dependencies

```bash
# Reinstall dependencies if needed
cd tools
rm -rf node_modules package-lock.json
npm install
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues or questions:
- Open an issue on GitHub
- Check the troubleshooting section above
- Review the workflow documentation in `prompts/my-common-prompts.md`

## Changelog

### Version 1.0.0
- Initial release
- Linear integration
- 8-step workflow implementation
- Knowledge management system
- Custom agents for specialized tasks
- TDD workflow support
