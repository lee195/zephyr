# zephyr-codex

Take Zephyr notes in Codex. Type a message that starts with `[zephyr] ` and send it. Codex keeps it in the session's rollout file, and the Zephyr server copies it from there. Ordinary messages in the same session stay ordinary chat.

Codex has no way to keep a message without a model turn, so each note still costs one. The AGENTS.md rule here keeps that reply to a single `.`. Measured with codex-cli 0.163.0 on `deepseek-v4-flash-fast`: each note turn sent about 6,700 input tokens and got 2 output tokens back. The input is the session's whole context, so a note in a long working session costs as much input as any other turn there.

Tested with codex-cli 0.163.0, in `codex exec` and `codex exec resume`. The interactive TUI writes the same rollout files but was not tested.

## Enable

1. Add the rule in [AGENTS.md](AGENTS.md) to the AGENTS.md Codex reads: a project's own (tested), or the global `~/.codex/AGENTS.md` for every project (untested).
2. Register sessions with the server through Codex's `notify` command, in `~/.codex/config.toml`:

   ```toml
   notify = ["bun", "/path/to/jlee-mods/zephyr-codex/notify.ts"]
   ```

   To reach Zephyr on a port other than 7317, append `"--port", "7400"` to the list. `notify` holds one command, so if you already use it for something else, call both from a wrapper script.

## How registration works

Codex runs the `notify` command after every turn, with a JSON payload as its last argument. When the turn's input holds a `[zephyr] ` message, `notify.ts` finds the thread's rollout, `$CODEX_HOME/sessions/**/rollout-*-<thread id>.jsonl` (`~/.codex` by default), and sends `POST /sessions { harness: "codex", sessionId, transcriptPath }`. The server reads the rollout from the start, so a server that was down when a note was taken loses nothing: the next note registers the thread again, and earlier notes are backfilled.

Codex 0.163.0 also has hooks, with `SessionStart` and `UserPromptSubmit` events that carry `transcript_path`, and a `UserPromptSubmit` hook may answer `decision: "block"`. Hooks run only once you trust them in Codex, and a hook in an untrusted `hooks.json` did not run under `codex exec`. Whether a blocked prompt still lands in the rollout is untested, so a hook that keeps a note without a model turn is an open question. `notify` lives in your own config and runs without a trust step.
