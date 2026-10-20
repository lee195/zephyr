# Zephyr mod for Claude Code

Notes mode for Claude Code: what you type is kept in the transcript as a `[zephyr]` note, with no model reply, and registered with the local Zephyr server that organizes the notes. A band above the prompt shows the mode, the server's state and where the last note was filed.

| Command | What it does |
| --- | --- |
| `/zephyr` | Toggles notes mode |
| `/zephyr review` | Reviews the notes since the last review |
| `/zephyr where <words>` | Lists matching notes with their topics |

The mod is built from Claude Code's function hooks (`hooks/register.tsx`), so it needs a Claude Code build that loads function-hook mods through `CLAUDE_CODE_PLUGIN_DIRS`; it was built and tested on Claude Code 2.1.303. If `claude plugin test --help` reports an unknown command, your build cannot load it, and the [opencode plugin](../opencode/) is the way to take notes.

## Install

Point `CLAUDE_CODE_PLUGIN_DIRS` at this folder in `~/.claude/settings.json`. Several mod folders are separated with colons:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/zephyr/mods/claude-code"
  }
}
```

Restart Claude Code to load it, because the variable is read at startup.

## Review

`/zephyr review` starts a model turn with Zephyr's review brief: the digest of the notes since the last review and the review's rules. You direct the review. The agent applies only what you ask, applies its own suggestions only after you say yes, and acts through Zephyr's MCP tools. It closes the review when you say it is done. Turning notes mode off says how many notes wait, such as `3 notes since last review · /zephyr review`.

The agent needs the Zephyr MCP server, added once under the name `zephyr`:

```sh
claude mcp add --transport http --scope user zephyr http://127.0.0.1:7317/mcp
```

Without it, `/zephyr review` prints this line and starts no turn. With a server that is down, it says so.

## Options

The mod talks to the Zephyr server on `127.0.0.1:7317`. To use another port, set it under `pluginConfigs`:

```json
{
  "pluginConfigs": {
    "zephyr@inline": { "options": { "port": 7400 } }
  }
}
```

In notes mode, slash commands still run and a prompt with an image is refused rather than noted. A note is written to the transcript before the server hears of it, so a server that is down loses nothing. It reads the transcript from the start when the session registers, and the mod registers the session again when the band's status check sees the server come back up, so notes typed during an outage arrive with no further note.

## Layout and tests

```
.claude-plugin/plugin.json   manifest (name, description, userConfig)
hooks/hooks.json             lists the hook modules to load
hooks/register.tsx           the hooks: session.start, command.run, ui.render, ...
hooks/notes.ts               transcript paths and note text
hooks/*.test.ts(x)           tests
types/index.d.ts             the mod's own types
```

Run the tests with `bun run test:mod` from the repo root, or `claude plugin test mods/claude-code`. Claude Code generates the API type stubs in `.claude-plugin/types/`, which ignores itself.
