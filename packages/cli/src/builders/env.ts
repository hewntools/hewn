// SPDX-License-Identifier: AGPL-3.0-or-later
// What a builder's environment keeps from Hewn's own: shared by the runs (cli.ts), the intake and the builders' homes (sign-in.ts).

/**
 * What a builder's environment keeps: the basics, its own model and login settings (the providers'
 * API keys OpenCode reads from the environment among them), proxies and CAs. Not the rest of yours
 * (tokens), and not OpenCode's own config variables: the run gets its own.
 */
const BUILDER_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|TZ|TMPDIR|LC_\w+|(ANTHROPIC|CLAUDE|OPENAI|CODEX)_\w+|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR))$/;
/** The other providers' keys OpenCode reads from the environment: its run only, no other builder's. */
export const OPENCODE_PROVIDER_ENV = /^((OPENROUTER|GEMINI|GOOGLE_GENERATIVE_AI|XAI|GROQ|MISTRAL|DEEPSEEK|OPENCODE)_API_KEY|OLLAMA_HOST)$/;
export const builderEnv = (env: NodeJS.ProcessEnv = process.env, also?: RegExp): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => BUILDER_ENV.test(k) || (also?.test(k) ?? false)));
