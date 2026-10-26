// SPDX-License-Identifier: AGPL-3.0-or-later
// The SurfaceHost for the in-process test host: settings in platform.json, intake and agent setup
// via local CLIs, backups as zip files, static assets from the packages (the CLI's lookup).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backupLocation, backupNow, listBackups, sameDisk } from "@hewntools/cli/backup.ts";
import { readConfig, writeConfig } from "@hewntools/cli/config.ts";
import type { Home } from "@hewntools/cli/home.ts";
import type { Intake } from "@hewntools/cli/intake.ts";
import { connectHarness } from "@hewntools/cli/setup/connect.ts";
import { toolStatus } from "@hewntools/cli/setup/tools.ts";
import { DATA_FORMAT, VERSION } from "@hewntools/cli/supervisor/format.ts";
import { harnessStatuses } from "@hewntools/cli/setup/harnesses.ts";
import { sourceAsset } from "@hewntools/cli/assets.ts";
import { readShelf, shelfImage } from "@hewntools/cli/shelf.ts";
import type { SetupHooks } from "@hewntools/cli/setup/hooks.ts";
import type { ModelCatalog, SurfaceHost } from "@hewntools/host-workerd/surface/host.ts";
import { offlineCatalog } from "@hewntools/cli/builders/models.ts";

export function nodeSurfaceHost(home: Home, opts: { port: number; log?: (line: string) => void; intake?: Intake; setup?: SetupHooks; models?: (agent: string) => Promise<ModelCatalog>; shelfDir?: string }): SurfaceHost {
  const log = opts.log ?? ((l: string) => console.error(`[${new Date().toISOString()}] ${l}`));
  const setup = opts.setup;
  return {
    port: opts.port,
    log,
    asset: sourceAsset,
    settings: {
      read: async () => readConfig(home),
      write: async (change) => writeConfig(home, change as Parameters<typeof writeConfig>[1]),
    },
    intake: opts.intake,
    async intakeLog(entry) {
      const dir = join(home.root, "intake");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.log`), JSON.stringify(entry) + "\n");
    },
    tools: async () => toolStatus(),
    modelCatalog: opts.models ?? offlineCatalog,
    status: async () => {
      const { dir } = backupLocation(home, readConfig(home).backupDir);
      return { version: VERSION, dataFormat: DATA_FORMAT, lastBackup: listBackups(dir)[0]?.at ?? null, backupDir: dir };
    },
    ...(setup
      ? {
          setup: {
            async list() {
              return harnessStatuses(setup.harnesses(), setup.userHome, setup.appInstalled);
            },
            async connect(agentId, mcpUrl, event) {
              const h = setup.harnesses().find((x) => x.agentId === agentId)!;
              await connectHarness(h, { url: mcpUrl, userHome: setup.userHome }, event, { login: setup.login, log });
            },
          },
        }
      : {}),
    shelf: {
      tools: async () => readShelf(opts.shelfDir),
      image: async (id, name) => shelfImage(id, name, opts.shelfDir),
    },
    backups: {
      location: async () => backupLocation(home, readConfig(home).backupDir).dir,
      list: async () => listBackups(backupLocation(home, readConfig(home).backupDir).dir),
      now: async () => backupNow(home, backupLocation(home, readConfig(home).backupDir).dir),
      sameDisk: async () => sameDisk(home.root, backupLocation(home, readConfig(home).backupDir).dir),
    },
  };
}
