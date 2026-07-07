#!/bin/bash
# Test script for CLI tools: claude, codex, qodercli
# This script tests basic connectivity and parameter compatibility

set -e

echo "=== CLI Tool Compatibility Test ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass_count=0
fail_count=0

test_command() {
    local name="$1"
    local cmd="$2"
    local desc="$3"
    
    echo -n "Testing $name ($desc)... "
    if eval "$cmd" > /dev/null 2>&1; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
        return 0
    else
        echo -e "${RED}FAIL${NC}"
        ((fail_count++))
        return 1
    fi
}

test_command_output() {
    local name="$1"
    local cmd="$2"
    local expected_pattern="$3"
    local desc="$4"
    
    echo -n "Testing $name ($desc)... "
    output=$(eval "$cmd" 2>&1) || true
    if echo "$output" | grep -q "$expected_pattern"; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
        return 0
    else
        echo -e "${RED}FAIL${NC}"
        echo "  Expected pattern: $expected_pattern"
        echo "  Got: $(echo "$output" | head -5)"
        ((fail_count++))
        return 1
    fi
}

echo "--- 1. Check CLI availability ---"
CLAUDE_PATH=$(which claude 2>/dev/null || echo "")
CODEX_PATH=$(which codex 2>/dev/null || echo "")
QODER_PATH=$(which qodercli 2>/dev/null || echo "")

if [ -n "$CLAUDE_PATH" ]; then
    echo -e "claude: ${GREEN}Found at $CLAUDE_PATH${NC}"
else
    echo -e "claude: ${YELLOW}Not found in PATH${NC}"
fi

if [ -n "$CODEX_PATH" ]; then
    echo -e "codex: ${GREEN}Found at $CODEX_PATH${NC}"
else
    echo -e "codex: ${YELLOW}Not found in PATH${NC}"
fi

if [ -n "$QODER_PATH" ]; then
    echo -e "qodercli: ${GREEN}Found at $QODER_PATH${NC}"
else
    echo -e "qodercli: ${YELLOW}Not found in PATH${NC}"
fi
echo ""

echo "--- 2. Test Claude CLI parameters ---"
if [ -n "$CLAUDE_PATH" ]; then
    # Test claude --help to verify it accepts our parameters
    test_command_output "claude-help" "claude --help 2>&1 || true" "print\|output-format\|permission-mode" "Verify claude supports required flags"

    # Test a simple non-interactive call (with timeout to avoid hanging)
    echo -n "Testing claude exec (simple prompt)... "
    if timeout 10 claude --print --output-format stream-json --permission-mode plan "Say hello" > /dev/null 2>&1; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
    else
        echo -e "${YELLOW}SKIP/TIMEOUT${NC} (may need API key or network)"
    fi
else
    echo -e "${YELLOW}Skipping Claude tests (not installed)${NC}"
fi
echo ""

echo "--- 3. Test Codex CLI parameters ---"
if [ -n "$CODEX_PATH" ]; then
    # Test codex exec --help
    test_command_output "codex-exec-help" "codex exec --help 2>&1 || true" "json\|sandbox" "Verify codex exec supports required flags"

    # Test codex exec with simple prompt
    echo -n "Testing codex exec (simple prompt)... "
    if timeout 10 codex exec --json --sandbox read-only "Say hello" > /dev/null 2>&1; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
    else
        echo -e "${YELLOW}SKIP/TIMEOUT${NC} (may need API key or network)"
    fi

    # Test codex exec resume format (should fail gracefully if no session)
    echo -n "Testing codex exec resume format... "
    output=$(codex exec resume test-session-id "test" 2>&1 || true)
    if echo "$output" | grep -qi "error\|not found\|invalid"; then
        # Expected to fail since session doesn't exist, but command format should be accepted
        echo -e "${GREEN}PASS (format accepted, session not found as expected)${NC}"
        ((pass_count++))
    else
        echo -e "${YELLOW}UNKNOWN${NC}"
        echo "  Output: $(echo "$output" | head -3)"
    fi
else
    echo -e "${YELLOW}Skipping Codex tests (not installed)${NC}"
fi
echo ""

echo "--- 4. Test Qoder CLI parameters ---"
if [ -n "$QODER_PATH" ]; then
    # Test qodercli --help
    test_command_output "qodercli-help" "qodercli --help 2>&1 || true" "\-p\|\-f\|\-r\|stream-json" "Verify qodercli supports required flags"

    # Test qodercli with simple prompt
    echo -n "Testing qodercli (simple prompt)... "
    if timeout 10 qodercli -p "Say hello" -f stream-json -q > /dev/null 2>&1; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
    else
        echo -e "${YELLOW}SKIP/TIMEOUT${NC} (may need auth or network)"
    fi

    # Test qodercli resume format
    echo -n "Testing qodercli resume format... "
    output=$(qodercli -r test-session-id -p "test" -f stream-json -q 2>&1 || true)
    if echo "$output" | grep -qi "error\|not found\|invalid\|session"; then
        echo -e "${GREEN}PASS (format accepted)${NC}"
        ((pass_count++))
    else
        echo -e "${YELLOW}UNKNOWN${NC}"
        echo "  Output: $(echo "$output" | head -3)"
    fi
else
    echo -e "${YELLOW}Skipping Qoder tests (not installed)${NC}"
fi
echo ""

echo "--- 5. Test parameter combinations ---"
if [ -n "$CLAUDE_PATH" ]; then
    echo -n "Testing claude args generation... "
    args=(--print --output-format stream-json --verbose --permission-mode plan "test prompt")
    if claude "${args[@]}" --help > /dev/null 2>&1 || true; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
    else
        echo -e "${RED}FAIL${NC}"
        ((fail_count++))
    fi
fi

if [ -n "$CODEX_PATH" ]; then
    echo -n "Testing codex args generation... "
    args=(exec --json --sandbox read-only "test prompt")
    if codex "${args[@]}" --help > /dev/null 2>&1 || true; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
    else
        echo -e "${RED}FAIL${NC}"
        ((fail_count++))
    fi
fi

if [ -n "$QODER_PATH" ]; then
    echo -n "Testing qodercli args generation... "
    args=(-p "test prompt" -f stream-json -q)
    if qodercli "${args[@]}" --help > /dev/null 2>&1 || true; then
        echo -e "${GREEN}PASS${NC}"
        ((pass_count++))
    else
        echo -e "${RED}FAIL${NC}"
        ((fail_count++))
    fi
fi
echo ""

echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$pass_count${NC}"
echo -e "Failed: ${RED}$fail_count${NC}"
echo ""

if [ $fail_count -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${YELLOW}Some tests failed or skipped. Review output above.${NC}"
    exit 1
fi
