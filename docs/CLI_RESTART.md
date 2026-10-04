# Restarting an individual CLI

Each installed CLI row has a **Restart** action. Bridge launches a new CLI process for each turn, so this action prepares and checks the next session. It does not restart Bridge, close your terminal windows, or cancel a running job.

When the CLI has active work, restart is queued. New work for that provider pauses while existing jobs finish; other providers remain available. After the provider is idle, Bridge starts the currently installed executable, checks its exit status and version, reads its authorization state, and refreshes the displayed version and update status. A version check does not make an inference request or prove a new provider response.

If current work takes more than ten minutes to finish, the queued action reports that user action is needed and removes its own admission pause without updating or restarting. Request it again when the CLI is idle. If an updater has already started, its admission pause remains until its terminal completion is known. After fifteen minutes, check the visible updater console; Bridge continues watching for completion. A failed version probe also retains its pause if its owned process has not closed.

Updates queue while that CLI has active work. Once idle, Bridge runs the fixed vendor update and automatically performs the same next-session preparation, keeping new work paused throughout. Bridge owns this sequence even if you close or reload the console page; **Restart** remains available as a manual fallback. A failed update or successful rollback is reported as a failed update, even if the restored version works. Cleanup warnings remain visible separately from the installed-version result.

Manually opened CLI terminals are not owned by this action. Follow any vendor instruction to close or reopen those terminals yourself. File-lock errors can have other causes; Bridge does not kill unrelated processes or claim every cleanup warning was caused by a running CLI.

The provider's **Channels** setting controls its total capacity on this Bridge. A separate app-level shared-Bridge allowance can limit each borrower to fewer channels. For Grok, token refresh can temporarily serialize its physical pool; the app's borrower allowance is independent of that mechanism.
