# Your data

Everything lives in Hewn's home folder, `~/.hewn` (or wherever `HEWN_HOME` pointed when you ran `hewn service install`). Each [tool](concepts.md#tools) has its own SQLite database there. Hewn's log is `~/.hewn/logs/hewn.log`.

## Backups

Hewn backs up every night: one zipped snapshot of all tools' data and Hewn's own state. It keeps the last 7 days, and one a week for 4 weeks before that. A backup never contains secrets in plain text or usable agent tokens.

Backups go to `~/.hewn-backups` (next to the home, named after it). Put them somewhere safer, such as a synced folder or another disk:

```sh
hewn backup dir ~/Library/Mobile\ Documents/com~apple~CloudDocs/hewn-backups
```

Or Settings › Data › Folder. Settings › Data warns you when backups are on the same disk as the data: if that disk fails, both are lost.

```
hewn backup now                 a backup right away (also Settings › Data › Back up now)
hewn backup list
hewn backup restore <date|file>
```

Restoring replaces the data and keeps Hewn running: it stops and starts its runtime itself. What was replaced is kept next to the data. Hewn also takes a backup itself before every upgrade, and before migrating a tool's data to a new version.

## Export

**Export data** in a tool's menu, or **Export** in Info › Data, downloads all its data as JSON. Or `hewn export <id> --out file.json`. Info › Data also shows how many rows the tool keeps, in how many tables, and when it last wrote.

Export is your data, for you. **Share…** is the tool, for someone else: its code and its made-up sample data, never your data ([Sharing tools](sharing.md)). To take your tools and their data to another machine, use a backup ([below](#moving-to-a-new-machine)).

## How big a tool's data can get

Each tool's data has a size limit: 100 MB unless you change it, in Settings › Data › Each tool's data. A write that would take a tool past its limit fails, and so does the call that made it: "Plant Log's data is at its 100 MB limit, so it can't save more. The limit is in Settings › Data." Reading still works, and so does deleting: what a tool deletes makes room again. The error is in the tool's call log (`hewn logs <id>`) and in Hewn's log.

The limit holds for each copy of a tool's data on its own: its data, and the copies Hewn makes to test it while it installs or changes, and before an upgrade. A tool's tests and sample data have the same limit, so a tool that writes past it doesn't install. A tool that already holds more than a new, smaller limit keeps its data, and can't add more until it deletes some or you raise the limit.

From the terminal:

```
hewn data limit                 each tool's limit, and the tools with their own
hewn data limit 250             every tool's limit, in MB
hewn data limit <id> 1000       one tool's own (default: back to every tool's)
```

When the disk with Hewn's data is nearly full (less than 1 GB free, or a tenth of a small disk), no tool can add data: a call that would fails with "Plant Log can't save more: the disk with Hewn's data has less than 1 GB free." Reading still works, and Hewn keeps running. Free some space and tools can save again within seconds.

## Start over

Info › Data › **Start over** empties a tool's data and keeps the tool; a copy of its data is kept aside first. `hewn data reset <id>` from the terminal. See [Sharing tools](sharing.md#start-over).

## Versions and rollback

Every change to a tool is a new version, and your data moves forward with it. Restore an earlier version from **Versions** (Info) or `hewn rollback <id> [version]`. See [Building tools](building-tools.md#versions).

## Deleted tools

Deleting a tool keeps its data. Settings › Data › Deleted tools brings it back (**Restore**), or deletes it forever. See [Building tools](building-tools.md#deleting-a-tool).

## Call logs

Every call to a tool is logged: who called it, when, and how it went, with up to 200 of the tool's own log lines (500 characters each) and, for a failed call, its error (1,000 characters). Settings › Data › Keep call logs sets how long (two weeks by default). Builds, grants and access changes are always kept. `hewn logs <id>` shows a tool's calls.

## Moving to a new machine

Backups never contain the secrets key, so secrets restored on another machine (or in another home folder) can't be read. Hewn starts anyway: `hewn doctor` and the restore list them, and each tool asks for its keys again.

To keep them, bring the old key across before you restore:
- **macOS:** on the old Mac, `security find-generic-password -s hewn-master -a <old home path> -w`. On the new one, `security add-generic-password -U -s hewn-master -a <new home path> -w <key>`. 
- **Linux or WSL with a key file:** copy `<old home>/master.key` to the new home (mode 600).
- **Linux with a desktop keyring:** `secret-tool lookup service hewn-master home <old home path>`, then `secret-tool store --label="Hewn secrets key" service hewn-master home <new home path>` and paste it.

Then `hewn backup restore <file>` and `hewn service restart`. Keep the key as safe as the secrets themselves.
