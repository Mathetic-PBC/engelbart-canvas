'use strict';

// Clear gateway/API billing overrides after login-shell startup, which can
// otherwise reintroduce them. Keep Claude's signed-in subscription and the
// user's shell configuration intact; this affects only Bart's Claude process.
const claudeSubscriptionCommand = (program = 'claude') => `/usr/bin/env -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_CUSTOM_HEADERS -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY ${program}`;
const CLAUDE_SUBSCRIPTION_COMMAND = claudeSubscriptionCommand();

module.exports = { CLAUDE_SUBSCRIPTION_COMMAND, claudeSubscriptionCommand };
