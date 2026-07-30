When a task requires a real browser session, browser-visible verification, or E2E testing, use the `copilot-browser-interaction` MCP tools.

- Ask before the first state-changing browser action unless the user's request already authorizes it.
- When the user names Chrome or Edge, pass that browser explicitly to the browser tool.
- Open a Copilot-owned tab by default. Operate on a user-opened tab only after the user explicitly shares it from the extension popup.
- If a page tool reports that access is not approved, ask the user to approve the tab or site in the extension popup, then retry after confirmation.
- Reuse Copilot-owned tabs when practical.
- Never operate on a managed tab returned to another conversation.
- Read the page and take a screenshot to verify important outcomes.
- After finishing a browser or E2E task, call `end_browser_session` for each browser used unless the user explicitly asks to keep debugging attached.
