# Sharing tools

A tool you made can travel as a file: you share it, someone installs it in their own Hewn, and it runs there as theirs. What travels is the code, never what's yours.

## What travels and what never does

A shared tool is one file, `<tool>.hewn.zip`, with one version's files as they are: its manifest (`capability.json`), code (`src/`), tests, database migrations, screens (`ui/`) and **sample data** (`sample/calls.json`). Hewn adds one small file that says which tool and version it is.

**Never in it:** your data, keys, settings, conversations with the builder, logs, or anything that says whose Hewn it came from.

## Sharing a tool

**Share…** on a tool (in Info's top bar, or the tool's menu) shows what the file would hold before you download it:

- **What's in it:** anything in the files that looks personal (an email address, a phone number, coordinates) or like a key (`sk-…`, a GitHub or AWS token, a long random string), each with the file and line, partly hidden; **Show** reveals it. These are warnings: test data often trips them, so read them and decide.
- **Sample data:** how many calls it holds. Sharing needs it (below).
- **Download:** the file. Pick any version, not only the live one.

Two things stop a share:

- **One of your own stored values is in the code:** a key or a setting you gave any of your tools, or a model provider's key. Share… says which file and line, and **Change…** asks the builder to take it out. Share again once the new version is live.
- **No sample data.** **Ask builder** adds it (the usual way: it writes made-up entries that fit the tool), or **Write it yourself**.

From the terminal: `hewn share <id> [--version N] [--out file]` prints the same findings and writes the file unless something stops it.

![Share Running Log: a version picker, what's in it (its sample data, always included), what's never in it, and Download](images/share.png)

## Sample data

Sample data is what a tool looks like in use: a list of calls to its operations (`sample/calls.json`) that fill an empty tool with made-up entries. Whoever installs your tool can start with it instead of a blank screen, and screenshots of the tool use it. It holds made-up names and places, never yours.

Builders write sample data when they create a tool, and keep it working when a change reshapes the operations. For a tool from before that, **Ask builder** in Share… adds some. **Write it yourself** opens `sample/calls.json` in an editor: saving makes a new version, which goes live only if every call runs without an error on an empty tool. The calls run before the tool is allowed anything, so they're plain writes: no network, no other tools, no model. The format is in [the tool spec](../spec/tools.md#sample-data-since-25).

## Installing a tool someone shared

**Install from a file** (Settings › Data, or search for it with `⌘K`) takes a `.hewn.zip`, up to 5 MB.

First, the agent that builds your tools reads its code and says what it does with your data, usually in under a minute: **What it does**, and **What it found**: warnings you should know about before installing (it says one thing and does another, it asks for something it never uses, data leaves for a host or the model without the description saying so), each with **Show** to see the code at that line, and what checks out. It's advice: the code is what runs, and **Source code ›** has all of it. **Install anyway** skips the reading. With no builder set up, there's no reading; the code is still there to read. On a hosted Hewn, the reading uses Credits, as a turn with the intake does.

Then one sheet shows:

- **What it does**, its warnings, and **Source code ›**: every file, as it is, before you install it.
- **It will ask for:** the hosts it reaches, a model, other tools, keys or settings. This is a preview: nothing is granted by installing. The tool asks once it's installed, as any new tool does.
- **Name:** its own, or "Plant Log 2" if you already have a Plant Log. The tool's id comes from the name.
- **Start with sample data**, ticked when it has some.

![Install Plant Log from Hub: what it does, a warning that it sends a photo to the model when asked, Source code, what it will ask for, its name and Start with sample data](images/install.png)

Installing runs the tool's own tests, as for any build, but no builder: the code is the file's. Then the tool opens and asks for what it needs.

Info shows where it came from ("from a file · Plant Log v7"). Change it like any of your tools: it's yours now, and nothing pulls updates from where it came from.

A file is refused with the reason when it isn't a tool Hewn shared, it's over 5 MB, or the tool needs a newer Hewn (then `hewn upgrade` and try again).

From the terminal: `hewn install <file.hewn.zip> [--name "Plant Log 2"] [--no-sample]`.

Tools from Hub (from Hewn 0.5) and Hewn's own come with Hewn's reading already, so they skip the wait; **Check it yourself** has your builder read them too.

## The Hub

The **Hub** tab holds tools ready to install. In this release it's Hewn's own (**Official**): Habits, Plant Log, Gift Ideas, Kid Quotes, Idea Tracker, Reading List and Running Log, shipped with Hewn (`seeds/` in the repo) and installed the same way as a file, from Hub, with Hewn's reading and their sample data. They're yours once installed, like any tool. Tools from other people come to the same Hub later.

## Start over

Info › Data › **Start over** empties a tool's data and keeps the tool: after trying it with sample data, or any time you want it empty. You type the tool's id to confirm, and can tick **And replay the sample data**. A backup of the data is kept (the newest three). From the terminal: `hewn data reset <id> [--sample]`.

## Is it safe to install a tool from someone else?

It runs in the same sandbox as tools your builder makes, through the same checks: its manifest, its tests, its migrations. Nothing in the file can grant itself anything: what it reaches (hosts, a model, your other tools) is asked of you after it's installed, one grant at a time, as for any tool. A shared tool never holds keys: a connection's credentials stay with you. Read **Source code** first if you're unsure what it does with your data. See the [threat model](threat-model.md).
