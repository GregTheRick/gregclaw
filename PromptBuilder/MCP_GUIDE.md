# MCP Setup Guide - Gemma 4 Prompt Builder

This guide explains how to connect the Gemma 4 Prompt Builder CLI to various MCP (Model Context Protocol) clients. This allows LLMs (like Claude, GPT-4, or Copilot) to generate perfectly formatted Gemma 4 prompts automatically.

## 🚀 Pre-requisites

1. **Build the binary**:
   ```bash
   # Filter PATH to avoid WSL/Windows permission issues if applicable
   PATH=$(echo $PATH | tr ':' '\n' | grep -v "/mnt/c/" | tr '\n' ':' | sed 's/:$//') cargo tauri build --release
   ```
2. **Find your binary**:
   The binary is located at: `PromptBuilder/target/release/tauri-app`

---

## 🛠️ 1. Integration with OpenClaw (This Project)

To add the prompter to OpenClaw's internal MCP registry, add the following to your `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "gemma4-prompter": {
        "command": "/absolute/path/to/PromptBuilder/target/release/tauri-app",
        "args": ["--json"]
      }
    }
  }
}
```

> [!NOTE]
> OpenClaw's MCP client will automatically pass the required JSON structure to the `--json` flag when the model requests a prompt generation.

---

## 🤖 2. VSCode: Roo Code / Claude Dev

Roo Code (formerly Claude Dev) supports local MCP servers. To add it:

1. Open **Roo Code Settings** in VSCode.
2. Click **Configure MCP Servers**.
3. Add this entry to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "gemma4-prompter": {
      "command": "/absolute/path/to/PromptBuilder/target/release/tauri-app",
      "args": []
    }
  }
}
```

---

## 🐙 3. GitHub Copilot (VSCode)

GitHub Copilot does not have native "local MCP" support yet, but you can bridge it using a small wrapper or by using an extension like **"MCP Client"**.

### Using a Bridge:

The easiest way is to use the **"MCP Bridge"** extension which exposes local MCP tools to the global VSCode command palette, making them accessible to Copilot Custom Instructions.

---

## 📋 JSON Input Format (Minimal)

The prompter now supports minimal JSON without manual IDs. The LLM can simply output:

```json
[
  {
    "role": "system",
    "components": [{ "ctype": "SystemText", "data": { "Text": "You are a helpful assistant." } }]
  },
  {
    "role": "user",
    "components": [{ "ctype": "Answer", "data": { "Text": "How do I use tool_call?" } }]
  }
]
```

## 🧪 Testing the CLI

You can test if it works directly from your terminal:

```bash
./target/release/tauri-app --json '[{"role": "user", "components": [{"ctype": "Answer", "data": {"Text": "Hello"}}]}]'
```

**Expected Output:**
`<|turn>user\nHello<turn|>\n`
