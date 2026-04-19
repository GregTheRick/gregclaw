# MCP Setup Guide - Gemma 4 Prompt Builder

This guide explains how to connect the Gemma 4 Prompt Builder to various MCP (Model Context Protocol) clients. By using the native **MCP Server Mode**, LLMs can automatically discover the prompter and generate correctly formatted Gemma 4 turn structures.

## 🚀 Pre-requisites

1. **Build the binary**:
   ```bash
   # Build the binary
   PATH=$(echo $PATH | tr ':' '\n' | grep -v "/mnt/c/" | tr '\n' ':' | sed 's/:$//') cargo tauri build
   ```
2. **Find your binary**:
   The binary is located at: `PromptBuilder/target/release/gemma4-prompt-builder-app`

---

## 🛠️ 1. Native MCP Server Mode (Recommended)

The Prompt Builder includes a native MCP stdio server. This is the **most robust** method as it allows the agent to see the exact structure required for Gemma 4 prompts.

### 🌌 Antigravity Agents

To make the prompter available to any **Antigravity agent**, add it to your configuration:

```json
{
  "mcp": {
    "servers": {
      "gemma4-prompter": {
        "command": "/absolute/path/to/PromptBuilder/target/release/gemma4-prompt-builder-app",
        "args": ["mcp"]
      }
    }
  }
}
```

### 🤖 VSCode: Roo Code / Claude Dev

1. Open **Roo Code Settings**.
2. Click **Configure MCP Servers**.
3. Add this entry to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "gemma4-prompter": {
      "command": "/absolute/path/to/PromptBuilder/target/release/gemma4-prompt-builder-app",
      "args": ["mcp"]
    }
  }
}
```

---

## 🛠️ 2. Legacy One-Shot CLI Mode

If you prefer to call the prompter as a simple shell command without using the MCP protocol:

### OpenClaw Integration

```json
{
  "mcp": {
    "servers": {
      "gemma4-prompter": {
        "command": "/absolute/path/to/PromptBuilder/target/release/gemma4-prompt-builder-app",
        "args": ["--json"]
      }
    }
  }
}
```

---

## 📋 How Agents See the Tool

When running in `mcp` mode, the prompter exposes the following tool to the agent:

- **Name**: `format_gemma4_prompt`
- **Description**: Converts a structured JSON list of turns into a Gemma 4 raw prompt.
- **Schema**: The agent automatically receives the JSON Schema, ensuring it always generates valid `role`, `ctype`, and `data` fields.

---

## 🧪 Manual Verification

### Test the MCP handshake:

```bash
# Start the server and paste this line into STDIN:
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

### Test the One-Shot CLI:

```bash
./target/release/gemma4-prompt-builder-app --json '[{"role": "user", "components": [{"ctype": "answer", "data": {"text": "Hello"}}]}]'
```

**Expected Output:**
`<|turn>user\nHello<turn|>\n`
