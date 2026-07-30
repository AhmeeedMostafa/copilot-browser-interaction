import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = {
  name: "copilot-browser-interaction",
  type: "stdio",
  command: process.execPath,
  args: [path.join(root, "src", "mcp.mjs")]
};
const vscode = process.env.VSCODE_CLI ?? "code";
for (const profile of [undefined, "Agents"]) {
  const result = spawnSync(vscode, [
    ...(profile ? ["--profile", profile] : []),
    "--add-mcp",
    JSON.stringify(config)
  ], { stdio: "inherit" });

  if (result.error?.code === "ENOENT") {
    throw new Error("VS Code CLI was not found. Install the `code` command, or use MCP: Add Server and enter the configuration from README.md.");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`VS Code rejected the MCP configuration${profile ? ` for ${profile}` : ""}`);
}

console.log("Installed copilot-browser-interaction in the default and Agents profiles.");
console.log('Enable "chat.mcp.autoStart": true in User Settings to start MCP servers automatically.');
