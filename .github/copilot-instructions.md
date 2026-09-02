When a task requires a real browser session, browser-visible verification, or E2E testing, use the `copilot-browser-interaction` MCP tools.

- Ask before the first state-changing browser action unless the user's request already authorizes it.
- When the user names Chrome or Edge, pass that browser explicitly to the browser tool.
- Open a Copilot-owned tab by default. Operate on a user-opened tab only after the user explicitly shares it from the extension popup.
- Do not ask the user to approve a tab before attempting an action — an existing per-site/per-tab grant or auto-approval may already cover it. Only ask for approval, and retry, after a tool call actually fails with an access-not-approved error.
- Reuse Copilot-owned tabs when practical.
- Default to `batch_browser_actions` for any scenario with a known sequence of steps (fill a form, click through a fixed flow): plan every step and send them in one call. Fall back to the separate single-purpose tools only when the next step depends on a result you don't have yet, an action isn't supported inside a batch (screenshot, console, resize, tab lifecycle), or a batch call itself fails — then retry just the remaining steps individually.
- Never operate on a managed tab returned to another conversation.
- Read the page and take a screenshot to verify important outcomes.
- After finishing a browser or E2E task, call `end_browser_session` for each browser used unless the user explicitly asks to keep debugging attached.
