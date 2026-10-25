Empir3 Bridge 0.3.95 is the unified desktop and headless release for Windows, macOS, and Linux.

Highlights:

- Fixes the project-mirror conflict storm by tracking the last content synchronized in either direction.
- Applies routine workspace updates to the plain local file when that file has not been changed locally.
- Parks exactly one conflict sidecar when both the workspace and local machine genuinely changed the same file.
- Keeps conflict sidecars and `.empir3-sync-state.json` local to the machine that created them so they cannot spread across mirrors.
- Records accepted local-upload hashes from the server acknowledgement before evaluating the next workspace update.
- Reliably persists Grok token rotations when Windows security or indexing briefly locks the credential file.

The `.empir3-sync-state.json` file at a connected project root is expected durable Bridge state. Deleting it is safe, but temporarily returns that project to conservative conflict handling until the state is rebuilt.

All native packages must complete the Windows, macOS, Linux x64, Linux ARM64, Node 18/20, installer, update, rollback, signing/notarization, MCP, and live Bridge acceptance gates before publication.

Download the signed installer for your platform at https://empir3.com/download.

Full changes: https://github.com/empir3hq/empir3-bridge/blob/v0.3.95/CHANGELOG.md
