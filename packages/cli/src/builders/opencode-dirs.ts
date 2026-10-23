// SPDX-License-Identifier: AGPL-3.0-or-later
// Where your own OpenCode keeps things, and how Hewn asks it questions: shared by the builder (what it seeds a run's home
// from), the sandbox (what it closes to builders), setup and uninstall (its config), Settings › AI (its model list).
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Your OpenCode's directories: the XDG base directories when `home` is your own home and they're set, else the
 * defaults under it (`~/.config/opencode`, `~/.local/share/opencode`, `~/.cache/opencode`, `~/.local/state/opencode`).
 * Another home (a test's, a build's) is never redirected by your environment.
 */
export const opencodeUserDirs = (home = homedir(), env: NodeJS.ProcessEnv = process.env) => {
  const xdg = (name: string, fallback: string) => join((home === homedir() && env[name]) || join(home, fallback), "opencode");
  return { config: xdg("XDG_CONFIG_HOME", ".config"), data: xdg("XDG_DATA_HOME", ".local/share"), cache: xdg("XDG_CACHE_HOME", ".cache"), state: xdg("XDG_STATE_HOME", ".local/state") };
};

/** Your OpenCode's global config directory (`opencode.json`, `AGENTS.md`). */
export const opencodeConfigDir = (home: string, env: NodeJS.ProcessEnv = process.env) => opencodeUserDirs(home, env).config;

/** Environment for asking your own OpenCode a question (`opencode models`, `auth list`, `debug config`): no update check. */
export const OPENCODE_NO_UPDATE = { OPENCODE_CONFIG_CONTENT: '{"autoupdate":false}' } as const;
