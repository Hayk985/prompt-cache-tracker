<p align="center">
<img width="92" height="92" alt="prompt-cache-tracker-icon" src="https://github.com/user-attachments/assets/642d037a-ba4b-454f-ae6a-afa3def753d0" />
</p>

<h1 align="center">Prompt cache tracker</h1>

A Claude Code mod that shows how warm your prompt cache is and refreshes it for you if you want.

Claude Code caches your conversation, so each reply is faster and cheaper. After 5 minutes or 1 hour without activity the cache expires, and your next message pays to rebuild it. Prompt cache tracker shows the time left above the prompt and can refresh the cache before it expires **saving you money**.

<img width="1750" height="662" alt="progress-states" src="https://github.com/user-attachments/assets/cd2fbac9-470f-4822-a3fa-71469d715936" />

## Features

- Shows the time left. It detects whether your session uses the 5-minute or the 1-hour cache and counts down from each reply.
- Keeps the cache warm. When 10% of the cache's lifetime remains, it sends a short message to keep the cache warm. It automatically stops refreshing after 30 minutes (5-minute cache) or 12 hours (1-hour cache) of inactivity.
- Works in the terminal and the desktop app.

## Install

```bash
claude plugin marketplace add Hayk985/prompt-cache-tracker
claude plugin install prompt-cache-tracker@prompt-cache-tracker
```

## Commands

| Command | What it does |
| --- | --- |
| `/keep-warm` | Turns automatic refresh on or off. The `[✓] keep warm` button next to the tracker does the same. |
| `/cache-ttl` | Shows the cache TTL currently used by the tracker. |
| `/cache-ttl 5m` or `1h` | Sets the tracker's cache TTL to 5 minutes or 1 hour. |
| `/cache-ttl auto` | Automatically detects the cache TTL. This is the default. |

---
On an API-based plan, the prompt cache lasts 5 minutes by default. You can switch to the 1-hour cache (see [choosing the TTL](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself) in the Claude docs), but writing to it costs more than writing to the 5-minute cache, so check the pricing first.


## License

MIT
