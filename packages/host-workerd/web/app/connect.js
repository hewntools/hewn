// SPDX-License-Identifier: AGPL-3.0-or-later
// Connect an agent.
import { api, BRAND, CLI, commandBlock, enc, errorBox, fail, h, modal, postStream, sheetActions, sheetHead, skeleton, stepRow } from "../kit.js";
import { AGENT_CATALOG, agentRequestSheet, agentTile, ALL_JOBS, buildJobs, setJobs } from "./agents.js";
import { hewnMachine, put, settings } from "./frame.js";
import { buildsChosen } from "./home.js";

export { connectDialog };

// ---------- L4: Connect an agent ----------

/** Connect an agent. `agentId` (claude-code, codex) skips the list and connects that one; "cloud" and "other" open those steps. */
function connectDialog(agentId) {
  return modal(
    (close, dlg) => {
      const body = h("div", { class: "stack-lg" }, h("div", { class: "sheet-title" }, "Connect an agent"), skeleton("80%", "60%"));
      const back = () => h("div", { class: "actions flush between" }, h("button", { class: "ghost", onclick: showList }, "‹ Back"), h("button", { onclick: () => close() }, "Done"));
      const steps = (...items) => h("ol", { class: "steps plain small" }, items.filter(Boolean).map((s) => h("li", {}, s)));
      const showList = async () => {
        let list = [];
        let err = null;
        const machine = await hewnMachine();
        // Hosted: no agents on the machine to list; everything connects through the public address.
        if (!settings?.hosted) {
          try {
            list = await api("/setup/agents");
          } catch (e) {
            err = e;
          }
        }
        if (agentId === "cloud" || agentId === "other" || agentId === "cloud-desktop") {
          const how = agentId;
          agentId = undefined;
          return manual(how !== "other", how === "cloud-desktop");
        }
        const direct = agentId && list.find((x) => x.agentId === agentId && x.found);
        if (direct) {
          agentId = undefined;
          return connecting(direct);
        }
        put(
          body,
          h("div", { class: "sheet-title" }, "Connect an agent"),
          err && errorBox(err),
          h(
            "ul",
            { class: "list" },
            machine.here === "public" && h("li", {}, agentTile("claude-code", "Claude Code"), h("div", { class: "grow" }, h("span", {}, "An agent on the device you're using"), h("span", { class: "sub" }, "It connects to Hewn's public address")), h("button", { class: "sm", onclick: () => remote() }, "How")),
            list.map((x) => {
              const via = x.via && list.find((y) => y.agentId === x.via);
              const sub = x.cloud ? "Through your public address, like claude.ai" : !x.found ? `Not found on ${machine.word}` : x.connected ? "Connected" : `Found on ${machine.word}`;
              const button = x.cloud
                ? h("button", { class: "sm", onclick: () => manual(true, true) }, "How")
                : x.found && (!via || via.found)
                  ? x.connected
                    ? h("button", { class: "ghost sm", onclick: () => connecting(x) }, "Sign in again")
                    : h("button", { class: "primary sm", onclick: () => connecting(x) }, "Connect")
                  : null;
              return h("li", { class: x.found || x.cloud ? "" : "soon" }, agentTile(x.agentId, x.label), h("div", { class: "grow" }, h("span", {}, x.label), h("span", { class: "sub" }, sub)), button);
            }),
            h("li", {}, agentTile("claude", "claude.ai"), h("div", { class: "grow" }, h("span", {}, "claude.ai, ChatGPT"), h("span", { class: "sub" }, "Through your public address")), h("button", { class: "sm", onclick: () => manual(true) }, "How")),
            h("li", {}, h("span", { class: "app-icon md add" }, "+"), h("div", { class: "grow" }, h("span", {}, "Anything else"), h("span", { class: "sub" }, "MCP address + sign-in")), h("button", { class: "sm", onclick: () => manual(false) }, "How")),
          ),
          h("div", { class: "small faint" }, `Coming soon: ${AGENT_CATALOG.filter((c) => !c.connect).map((c) => c.label).join(", ")}.`),
          sheetActions(h("button", { onclick: () => close() }, "Close")),
        );
      };

      // An agent on the owner's own computer, reaching Hewn on a server through the public address.
      const remote = async () => {
        const m = await api("/setup/manual").catch((e) => (fail(e), null));
        if (!m?.publicUrl) return;
        put(
          body,
          h("div", { class: "sheet-title" }, "An agent on your device"),
          commandBlock(m.publicUrl, "Address"),
          steps("Add Hewn as a streamable HTTP MCP server with the address above.", "Its sign-in opens in your browser: approve it there.", "Claude Code only has a terminal for this. Paste:"),
          commandBlock(`claude mcp add --transport http hewn ${m.publicUrl}`),
          back(),
        );
      };

      const manual = async (cloud, desktop = false) => {
        const m = await api("/setup/manual").catch((e) => (fail(e), null));
        if (!m) return;
        const address = cloud || settings?.hosted ? m.publicUrl : m.url;
        put(
          body,
          h("div", { class: "sheet-title" }, desktop ? "Claude Desktop" : cloud ? "claude.ai and ChatGPT" : "Another MCP client"),
          cloud && !address && settings?.hosted
            ? h("div", { class: "notice" }, h("span", {}, "Your address isn't ready yet. Try again in a minute."))
            : cloud && !address
            ? [h("div", { class: "notice" }, h("span", {}, m.tunnel?.kind ? `Your tunnel is ${m.tunnel.state}${m.tunnel.error ? `: ${m.tunnel.error}` : ""}.` : "Agents in the cloud need a public address. Only MCP and sign-in go through it.")), h("div", { class: "small" }, "Start a tunnel in a terminal (only a terminal can):"), commandBlock(`${CLI} tunnel start --quick`)]
            : commandBlock(address, "Address"),
          address &&
            (desktop
              ? steps("Settings › Connectors › Add custom connector, and paste the address.", "Connect: approve it in Hewn when it asks.", "Paste the text below into Settings › Profile.")
              : cloud
                ? steps("claude.ai: Settings › Connectors › Add custom connector. ChatGPT: Settings › Connectors › Create.", "Paste the address. Connect, then approve it in Hewn.", "Paste the text below into your profile or custom instructions, so it thinks of Hewn.")
                : steps("Add Hewn as a streamable HTTP MCP server with this address.", "It signs in with OAuth: approve it in Hewn when it asks.")),
          cloud && address && m.pointer && commandBlock(m.pointer, "Instructions"),
          back(),
        );
      };

      const connecting = async (x) => {
        const words = (s) => (s.kind === "cleanup" ? "Removing the old token" : s.kind === "register" ? `Adding ${BRAND} to ${x.label}` : s.kind === "pointer" ? `Telling ${x.label} where to look` : `${x.label} signs in`);
        let plan = [];
        const state = []; // per step: done | live | fail
        let error = null;
        let finished = false;
        let lastLine = "";
        let signIn = null; // the sign-in page, for when no browser opened by itself
        const waiting = h("div", { class: "stack-md" });
        const offer = h("div", {});
        const render = () => {
          const labels = plan.map(words);
          const states = labels.map((_, i) => state[i] ?? (i === state.length && !error ? "live" : "todo"));
          put(
            body,
            sheetHead(agentTile(x.agentId, x.label, 44), finished && !error ? `${x.label} is connected` : `Connecting ${x.label}`, finished && !error ? h("span", { class: "pill accent" }, "uses your tools") : null),
            !finished && h("ol", { class: "steps" }, labels.map((l, i) => stepRow(l, states[i], i === plan.length - 1 && states[i] === "live" ? lastLine : "", states[i] === "fail" ? error : null))),
            error && errorBox(new Error(error)),
            !finished && !error && signIn && h("div", { class: "small" }, "No browser page opened? ", h("a", { href: signIn, target: "_blank", rel: "noopener" }, "Open the sign-in page"), "."),
            waiting,
            finished && !error && offer,
            finished && !error && h("div", { class: "small faint" }, "Start a new session so it sees the tools."),
            (error || finished) && sheetActions(error ? h("button", { onclick: showList }, "Back") : h("button", { class: "primary", onclick: () => close(true) }, "Done")),
          );
        };
        // O6: an agent on this machine can also build tools for Hewn; it starts unticked.
        const showOffer = async () => {
          const tool = AGENT_CATALOG.find((c) => c.connect === x.agentId)?.tool;
          if (!tool) return;
          const { tools, ready, settings: s, label } = await buildJobs();
          if (!ready(tools.find((t) => t.name === tool))) return;
          // Already the one building tools: nothing to offer.
          if (buildsChosen(s) && s.builder === tool) return;
          const sw = h("input", { type: "checkbox", class: "switch", "aria-label": "Build tools" });
          sw.addEventListener("change", async () => {
            try {
              if (sw.checked) await setJobs(ALL_JOBS, tool);
            } catch (e) {
              sw.checked = false;
              fail(e);
            }
          });
          put(
            offer,
            h("div", { class: "eyebrow" }, "It can also work for Hewn"),
            h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, "Build tools"), h("span", { class: "sub" }, `Today: ${buildsChosen(s) ? label(s.builder) : "nobody"}`)), sw),
          );
        };
        // While it signs in, its request appears here to approve without leaving the sheet.
        const seen = new Set((await api("/agents/pending").catch(() => [])).map((p) => p.id));
        let poll = null;
        const watch = () => {
          if (poll) return;
          poll = setInterval(async () => {
            const fresh = (await api("/agents/pending").catch(() => [])).filter((p) => !seen.has(p.id));
            if (!fresh.length) return;
            fresh.forEach((p) => seen.add(p.id));
            put(waiting, await agentRequestSheet(fresh[0], { inline: () => put(waiting) }));
          }, 1500);
        };
        dlg.addEventListener("close", () => clearInterval(poll), { once: true });
        dlg.addEventListener("cancel", (e) => !finished && !error && plan.length && e.preventDefault(), { once: true });
        render();
        try {
          await postStream(`/setup/agents/${enc(x.agentId)}`, (name, data) => {
            if (name === "plan") plan = data.steps;
            if (name === "step") data.ok ? (state[data.index] = "done") : ((state[data.index] = "fail"), (error = data.error));
            if (name === "login") {
              if (data.waiting) watch();
              if (data.line) lastLine = data.line.length > 90 ? `${data.line.slice(0, 90)}…` : data.line;
              if (data.authorizeUrl) signIn = data.authorizeUrl;
            }
            if (name === "done") {
              finished = true;
              clearInterval(poll);
              put(waiting);
              showOffer();
            }
            render();
          });
        } catch (e) {
          error = e.message;
          render();
        }
      };

      showList();
      return body;
    },
    { width: 520 },
  );
}
