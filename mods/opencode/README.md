# zephyr-opencode

Take Zephyr notes in opencode. This is an opencode TUI plugin, not a Claude Code mod. `/note` opens a note box inside the TUI. Each Enter keeps what you typed in the session as a user message starting with `[zephyr] `, sent with opencode's `noReply`, so no model turn runs. Esc ends notes. The note shows in the session, and a toast says `noted`. Ending notes shows a toast such as `3 notes since last review` when the server has notes nobody has reviewed yet. Run from the home screen, `/note` starts a new session.

After the first note of a session, the plugin registers it with the Zephyr server: `POST /sessions { harness: "opencode", sessionId, transcriptPath }`, where `transcriptPath` is opencode's database. The server reads notes from that database, so a server that is down loses nothing. If the first registration fails, a toast says so, and the next note tries again.

Tested with opencode 1.18.33.

## Enable

Add the plugin to a `tui.json`. That can be the project's `.opencode/tui.json`, the global `~/.config/opencode/tui.json`, or a file you name with `OPENCODE_TUI_CONFIG`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/path/to/jlee-mods/zephyr-opencode/zephyr.ts"]
}
```

Restart opencode to load it. To reach Zephyr on a port other than 7317, give the plugin options:

```json
{ "plugin": [["/path/to/jlee-mods/zephyr-opencode/zephyr.ts", { "port": 7400 }]] }
```

## Database path

The plugin computes the database path the way opencode's release channel does: `$OPENCODE_DB` if set, otherwise `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/opencode.db`). Compare with `opencode db path` if notes do not reach Zephyr. A dev or preview build of opencode uses a channel-named database that this path does not match.
