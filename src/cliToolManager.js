// CLI Tool Manager — manages switching between underlying CLI tools
// (e.g., claude, codex, qoder). Detects availability and persists the active tool.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.claude-console');
const CLI_TOOL_CONFIG_PATH = path.join(CONFIG_DIR, 'cli-tool.json');

// Supported CLI tools with their metadata and argument builders
const SUPPORTED_TOOLS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    description: 'Anthropic Claude Code CLI',
    // Build args for claude CLI
    buildArgs: ({ prompt, permissionMode, resumeSessionId, useStdin }) => {
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', permissionMode || 'plan',
      ];
      if (resumeSessionId) {
        args.push('--resume', resumeSessionId);
      }
      if (!useStdin && prompt) {
        args.push(prompt);
      }
      return args;
    },
    supportsResume: true,
    supportsStreamJson: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    description: 'OpenAI Codex CLI',
    // Build args for codex CLI - uses 'codex exec' for non-interactive mode
    buildArgs: ({ prompt, permissionMode, resumeSessionId, useStdin }) => {
      // Use 'exec' subcommand for non-interactive mode
      const args = ['exec'];
      
      // Output format: --json for JSONL event stream
      args.push('--json');
      
      // Approval mode mapping: plan -> untrusted (safest), other -> on-request
      const approvalMode = permissionMode === 'plan' ? 'untrusted' : 'on-request';
      args.push('--ask-for-approval', approvalMode);
      
      // Sandbox policy: plan -> read-only, other -> workspace-write
      const sandbox = permissionMode === 'plan' ? 'read-only' : 'workspace-write';
      args.push('--sandbox', sandbox);
      
      // Resume session if supported
      if (resumeSessionId) {
        args.push('resume', resumeSessionId);
      }
      
      // Prompt: either as argument or from stdin
      if (!useStdin && prompt) {
        args.push(prompt);
      } else if (useStdin) {
        args.push('-'); // Read from stdin
      }
      
      return args;
    },
    supportsResume: true,
    supportsStreamJson: true,
  },
  {
    id: 'qoder',
    name: 'Qoder CLI',
    command: 'qodercli',
    description: 'Qoder AI Coding Assistant CLI',
    // Build args for qoder CLI
    buildArgs: ({ prompt, permissionMode, resumeSessionId, useStdin }) => {
      const args = [];
      
      // Non-interactive mode with print
      if (prompt && !useStdin) {
        args.push('-p', prompt);
      }
      
      // Output format: stream-json for event streaming
      args.push('-f', 'stream-json');
      
      // Quiet mode to hide spinner
      args.push('-q');
      
      // Resume session if provided
      if (resumeSessionId) {
        args.push('-r', resumeSessionId);
      }
      
      // Permission mode: plan -> no special flag (default safe mode)
      // For full access, would use --dangerously-skip-permissions or --yolo
      // We don't add dangerous flags by default for safety
      
      return args;
    },
    supportsResume: true,
    supportsStreamJson: true,
  },
];

export class CliToolManager {
  constructor() {
    this.activeToolId = 'claude'; // default
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(CLI_TOOL_CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(CLI_TOOL_CONFIG_PATH, 'utf8'));
        if (config.activeToolId && this._isSupported(config.activeToolId)) {
          this.activeToolId = config.activeToolId;
        }
      }
    } catch (e) {
      console.error('[CliToolManager] load error:', e.message);
    }
  }

  _save() {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      const tmp = CLI_TOOL_CONFIG_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ activeToolId: this.activeToolId }, null, 2));
      fs.renameSync(tmp, CLI_TOOL_CONFIG_PATH);
    } catch (e) {
      console.error('[CliToolManager] save error:', e.message);
    }
  }

  _isSupported(toolId) {
    return SUPPORTED_TOOLS.some((t) => t.id === toolId);
  }

  /**
   * Check if a CLI tool is available on the system
   */
  checkAvailability(toolId) {
    const tool = SUPPORTED_TOOLS.find((t) => t.id === toolId);
    if (!tool) return { available: false, error: `Unknown tool: ${toolId}` };

    try {
      execSync(`which ${tool.command}`, { stdio: 'ignore' });
      return { available: true, command: tool.command };
    } catch {
      return { available: false, error: `${tool.command} not found in PATH` };
    }
  }

  /**
   * Get status of all supported tools
   */
  getAllToolsStatus() {
    return SUPPORTED_TOOLS.map((tool) => {
      const status = this.checkAvailability(tool.id);
      return {
        ...tool,
        ...status,
        isActive: tool.id === this.activeToolId,
      };
    });
  }

  /**
   * Get the currently active tool info
   */
  getActiveTool() {
    const tool = SUPPORTED_TOOLS.find((t) => t.id === this.activeToolId);
    if (!tool) return null;
    const status = this.checkAvailability(tool.id);
    return { ...tool, ...status };
  }

  /**
   * Switch to a different CLI tool
   */
  setActiveTool(toolId) {
    if (!this._isSupported(toolId)) {
      throw new Error(`Unsupported tool: ${toolId}`);
    }

    const status = this.checkAvailability(toolId);
    if (!status.available) {
      throw new Error(`${toolId} is not installed or not in PATH`);
    }

    this.activeToolId = toolId;
    this._save();
    return this.getActiveTool();
  }

  /**
   * Get the command name for the active tool
   */
  getActiveCommand() {
    const tool = SUPPORTED_TOOLS.find((t) => t.id === this.activeToolId);
    return tool ? tool.command : 'claude';
  }

  /**
   * Get list of supported tool IDs
   */
  getSupportedToolIds() {
    return SUPPORTED_TOOLS.map((t) => t.id);
  }

  /**
   * Get the argument builder for the active tool
   */
  getArgsBuilder() {
    const tool = SUPPORTED_TOOLS.find((t) => t.id === this.activeToolId);
    return tool ? tool.buildArgs : SUPPORTED_TOOLS[0].buildArgs;
  }

  /**
   * Check if the active tool supports session resume
   */
  supportsResume() {
    const tool = SUPPORTED_TOOLS.find((t) => t.id === this.activeToolId);
    return tool ? tool.supportsResume : false;
  }

  /**
   * Build args for the active tool
   */
  buildArgs(options) {
    const builder = this.getArgsBuilder();
    return builder(options);
  }
}
