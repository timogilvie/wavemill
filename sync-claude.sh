#!/bin/bash
# sync-claude.sh - Bidirectional sync between repo and ~/.claude / ~/.codex
# Usage: ./sync-claude.sh [to-claude|from-claude|to-codex|from-codex|status|links]

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CODEX_DIR="$HOME/.codex"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ensure_symlink() {
    local target="$1"
    local link_path="$2"
    local name="$3"

    mkdir -p "$(dirname "$link_path")"
    ln -snf "$target" "$link_path"
    echo -e "${GREEN}✓${NC} linked $name → $link_path"
}

show_status() {
    echo -e "${YELLOW}=== Sync Status ===${NC}\n"

    echo "Checking files that might differ for Claude..."

    # Check shared lib (canonical in repo, optionally synced to ~/.claude)
    if [ -d "$CLAUDE_DIR/shared/lib" ]; then
        for file in linear.js git.js github.js; do
            if [ -f "$REPO_DIR/shared/lib/$file" ]; then
                if [ -f "$CLAUDE_DIR/shared/lib/$file" ]; then
                    if ! diff -q "$CLAUDE_DIR/shared/lib/$file" "$REPO_DIR/shared/lib/$file" > /dev/null 2>&1; then
                        echo -e "${RED}✗${NC} shared/lib/$file - DIFFERS"
                        CLAUDE_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$CLAUDE_DIR/shared/lib/$file")
                        REPO_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$REPO_DIR/shared/lib/$file")
                        echo "  ~/.claude: $CLAUDE_DATE"
                        echo "  repo:      $REPO_DATE"
                    else
                        echo -e "${GREEN}✓${NC} shared/lib/$file - in sync"
                    fi
                else
                    echo -e "${YELLOW}⚠${NC}  shared/lib/$file - exists in repo only"
                fi
            fi
        done
    fi

    # Check tools
    for file in get-backlog.ts expand-issue.ts auto-label-issue.ts; do
        if [ -f "$CLAUDE_DIR/tools/$file" ] && [ -f "$REPO_DIR/tools/$file" ]; then
            if ! diff -q "$CLAUDE_DIR/tools/$file" "$REPO_DIR/tools/$file" > /dev/null 2>&1; then
                echo -e "${RED}✗${NC} tools/$file - DIFFERS"
                CLAUDE_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$CLAUDE_DIR/tools/$file")
                REPO_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$REPO_DIR/tools/$file")
                echo "  ~/.claude: $CLAUDE_DATE"
                echo "  repo:      $REPO_DATE"
            else
                echo -e "${GREEN}✓${NC} tools/$file - in sync"
            fi
        fi
    done

    # Check commands
    for file in workflow.md bugfix.md plan.md create-plan.md implement-plan.md validate-plan.md; do
        if [ -f "$CLAUDE_DIR/commands/$file" ] && [ -f "$REPO_DIR/commands/$file" ]; then
            if ! diff -q "$CLAUDE_DIR/commands/$file" "$REPO_DIR/commands/$file" > /dev/null 2>&1; then
                echo -e "${RED}✗${NC} commands/$file - DIFFERS"
                CLAUDE_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$CLAUDE_DIR/commands/$file")
                REPO_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$REPO_DIR/commands/$file")
                echo "  ~/.claude: $CLAUDE_DATE"
                echo "  repo:      $REPO_DATE"
            else
                echo -e "${GREEN}✓${NC} commands/$file - in sync"
            fi
        fi
    done


    # Symlink status for commands
    if [ -L "$CLAUDE_DIR/commands" ]; then
        echo -e "${GREEN}✓${NC} ~/.claude/commands is a symlink -> $(readlink "$CLAUDE_DIR/commands")"
    else
        echo -e "${YELLOW}⚠${NC} ~/.claude/commands is not a symlink"
    fi

    echo -e "\nChecking Codex commands..."
    if [ -f "$CODEX_DIR/commands.json" ] && [ -f "$REPO_DIR/codex/commands.json" ]; then
        if ! diff -q "$CODEX_DIR/commands.json" "$REPO_DIR/codex/commands.json" > /dev/null 2>&1; then
            echo -e "${RED}✗${NC} ~/.codex/commands.json - DIFFERS"
        else
            echo -e "${GREEN}✓${NC} ~/.codex/commands.json - in sync"
        fi
    else
        echo -e "${YELLOW}⚠${NC} ~/.codex/commands.json missing (or repo file missing)"
    fi

    if [ -L "$CODEX_DIR/commands.json" ]; then
        echo -e "${GREEN}✓${NC} ~/.codex/commands.json is a symlink -> $(readlink "$CODEX_DIR/commands.json")"
    else
        echo -e "${YELLOW}⚠${NC} ~/.codex/commands.json is not a symlink"
    fi

    echo -e "\nChecking Codex prompts..."
    if [ -d "$REPO_DIR/codex/prompts" ]; then
        if [ -d "$CODEX_DIR/prompts" ]; then
            for file in "$REPO_DIR/codex/prompts/"*.md; do
                [ -e "$file" ] || break
                filename=$(basename "$file")
                if [ -f "$CODEX_DIR/prompts/$filename" ]; then
                    if ! diff -q "$CODEX_DIR/prompts/$filename" "$file" > /dev/null 2>&1; then
                        echo -e "${RED}✗${NC} prompts/$filename - DIFFERS"
                    else
                        echo -e "${GREEN}✓${NC} prompts/$filename - in sync"
                    fi
                else
                    echo -e "${YELLOW}⚠${NC} prompts/$filename missing in ~/.codex"
                fi
            done
        else
            echo -e "${YELLOW}⚠${NC} ~/.codex/prompts missing"
        fi
    fi

    if [ -L "$CODEX_DIR/prompts" ]; then
        echo -e "${GREEN}✓${NC} ~/.codex/prompts is a symlink -> $(readlink "$CODEX_DIR/prompts")"
    elif [ -d "$CODEX_DIR/prompts" ]; then
        echo -e "${YELLOW}⚠${NC} ~/.codex/prompts exists but is not a symlink"
    fi
}

sync_to_claude() {
    echo -e "${GREEN}=== Syncing TO ~/.claude ===${NC}\n"

    # Sync shared lib (repo → ~/.claude)
    echo "Copying shared lib..."
    mkdir -p "$CLAUDE_DIR/shared/lib"
    cp -v "$REPO_DIR/shared/lib/"*.js "$CLAUDE_DIR/shared/lib/"

    # Sync tools (repo → ~/.claude)
    echo -e "\nCopying tools..."
    cp -v "$REPO_DIR/tools/get-backlog.ts" "$CLAUDE_DIR/tools/"
    cp -v "$REPO_DIR/tools/expand-issue.ts" "$CLAUDE_DIR/tools/"
    cp -v "$REPO_DIR/tools/auto-label-issue.ts" "$CLAUDE_DIR/tools/"

    # Sync commands (repo → ~/.claude)
    echo -e "\nCopying commands..."
    mkdir -p "$CLAUDE_DIR/commands"
    cp -v "$REPO_DIR/commands/"*.md "$CLAUDE_DIR/commands/"

    # Sync templates (repo → ~/.claude)
    if [ -d "$REPO_DIR/tools/prompts" ]; then
        echo -e "\nCopying templates..."
        mkdir -p "$CLAUDE_DIR/tools/prompts"
        rsync -av "$REPO_DIR/tools/prompts/" "$CLAUDE_DIR/tools/prompts/"
    fi

    echo -e "\n${GREEN}✓ Sync to ~/.claude complete${NC}"
}

sync_from_claude() {
    echo -e "${GREEN}=== Syncing FROM ~/.claude ===${NC}\n"

    # Sync shared lib (only if ~/.claude version is newer)
    if [ -d "$CLAUDE_DIR/shared/lib" ]; then
        echo "Checking shared lib for newer versions in ~/.claude..."
        for file in linear.js git.js github.js; do
            if [ -f "$CLAUDE_DIR/shared/lib/$file" ] && [ "$CLAUDE_DIR/shared/lib/$file" -nt "$REPO_DIR/shared/lib/$file" ]; then
                echo "  Copying newer shared/lib/$file from ~/.claude"
                cp -v "$CLAUDE_DIR/shared/lib/$file" "$REPO_DIR/shared/lib/"
            fi
        done
    fi

    # Sync tools (only if ~/.claude version is newer)
    echo -e "\nChecking tools for newer versions in ~/.claude..."
    for file in get-backlog.ts expand-issue.ts auto-label-issue.ts; do
        if [ "$CLAUDE_DIR/tools/$file" -nt "$REPO_DIR/tools/$file" ]; then
            echo "  Copying newer tools/$file from ~/.claude"
            cp -v "$CLAUDE_DIR/tools/$file" "$REPO_DIR/tools/"
        fi
    done

    # Sync commands (only if ~/.claude version is newer)
    echo -e "\nChecking commands for newer versions in ~/.claude..."
    for file in "$CLAUDE_DIR/commands/"*.md; do
        filename=$(basename "$file")
        if [ "$file" -nt "$REPO_DIR/commands/$filename" ]; then
            echo "  Copying newer $filename from ~/.claude"
            cp -v "$file" "$REPO_DIR/commands/"
        fi
    done

    echo -e "\n${GREEN}✓ Sync from ~/.claude complete${NC}"
}

sync_to_codex() {
    echo -e "${GREEN}=== Syncing TO ~/.codex ===${NC}\n"
    mkdir -p "$CODEX_DIR"
    cp -v "$REPO_DIR/codex/commands.json" "$CODEX_DIR/commands.json"
    if [ -d "$REPO_DIR/codex/prompts" ]; then
        echo -e "\nCopying prompts..."
        mkdir -p "$CODEX_DIR/prompts"
        rsync -av "$REPO_DIR/codex/prompts/" "$CODEX_DIR/prompts/"
    fi
    echo -e "\n${GREEN}✓ Sync to ~/.codex complete${NC}"
}

sync_from_codex() {
    echo -e "${GREEN}=== Syncing FROM ~/.codex ===${NC}\n"
    if [ -f "$CODEX_DIR/commands.json" ] && [ "$CODEX_DIR/commands.json" -nt "$REPO_DIR/codex/commands.json" ]; then
        echo "  Copying newer commands.json from ~/.codex"
        cp -v "$CODEX_DIR/commands.json" "$REPO_DIR/codex/commands.json"
    else
        echo "  No newer commands.json found in ~/.codex"
    fi
    if [ -d "$CODEX_DIR/prompts" ]; then
        mkdir -p "$REPO_DIR/codex/prompts"
        echo -e "\nChecking prompts for newer versions in ~/.codex..."
        for file in "$CODEX_DIR/prompts/"*.md; do
            [ -e "$file" ] || continue
            filename=$(basename "$file")
            if [ "$file" -nt "$REPO_DIR/codex/prompts/$filename" ]; then
                echo "  Copying newer $filename from ~/.codex/prompts"
                cp -v "$file" "$REPO_DIR/codex/prompts/"
            fi
        done
    fi
    echo -e "\n${GREEN}✓ Sync from ~/.codex complete${NC}"
}

create_links() {
    echo -e "${GREEN}=== Creating symlinks for Claude and Codex ===${NC}\n"
    ensure_symlink "$REPO_DIR/commands" "$CLAUDE_DIR/commands" "~/.claude/commands"
    ensure_symlink "$REPO_DIR/codex/commands.json" "$CODEX_DIR/commands.json" "~/.codex/commands.json"
    if [ -d "$REPO_DIR/codex/prompts" ]; then
        ensure_symlink "$REPO_DIR/codex/prompts" "$CODEX_DIR/prompts" "~/.codex/prompts"
    fi
    echo -e "\n${GREEN}✓ Symlinks created${NC}"
}

case "${1:-status}" in
    to-claude)
        sync_to_claude
        ;;
    from-claude)
        sync_from_claude
        ;;
    to-codex)
        sync_to_codex
        ;;
    from-codex)
        sync_from_codex
        ;;
    status)
        show_status
        ;;
    links)
        create_links
        ;;
    *)
        echo "Usage: $0 [to-claude|from-claude|to-codex|from-codex|status|links]"
        echo ""
        echo "  status       - Show sync status (default)"
        echo "  to-claude    - Copy repo files to ~/.claude"
        echo "  from-claude  - Copy newer ~/.claude files to repo"
        echo "  to-codex     - Copy repo commands.json to ~/.codex"
        echo "  from-codex   - Copy newer ~/.codex commands.json to repo"
        echo "  links        - Create/refresh symlinks for ~/.claude/commands and ~/.codex/commands.json"
        exit 1
        ;;
esac
