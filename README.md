# DSH Perplexity API Fix Plugin

A DeepSeek Harness (DSH) Host + Web plugin that keeps the **Perplexity API** route working for
Claude Opus 5.5, Claude Sonnet 5.5 and GPT-6.1 Sol, and repairs the provider settings that commonly make those calls fail.

> Unofficial community plugin. Not affiliated with Perplexity, Anthropic, OpenAI or DeepSeek.

## What it fixes

On every request sent to the `perplexity` provider (configurable) it:

| Problem | Fix |
|---|---|
| Anthropic models reject calls without an output cap | Fills `maxTokens` (sent as `max_output_tokens`), capped to the remaining context window |
| DSH tool names that collide with Perplexity built-ins (`web_search`, `fetch_url`, `sandbox`, …) return HTTP 400 | Renames them on the wire to `dsh_<name>` and restores the original name in the streamed tool calls |
| Tool schemas with `type: "object"` but no `properties`, or empty descriptions, return HTTP 400 | Adds `properties: {}` / a default description (arguments are never touched) |
| `stop`, out-of-range `temperature`, unsupported `reasoningEffort` | Removes or clamps them |

It also adds:

- **Sidebar page** ("Perplexity") showing the provider route, a settings check, and the last 40 rewrites/errors.
- **Repair settings** button / `perplexity_guard` agent tool (`action: "status" | "repair"`). Repair fills in, for the three focus models:
  `api: openai-responses`, `baseURL` (only if missing, defaults to `https://api.perplexity.ai/v1`), `maxTokens`, `contextWindow`,
  `reasoningEfforts` (low/medium/high/xhigh), `compat.supportsMaxOutputTokens`, and a 15-minute stream idle timeout.
  It never removes other models and never replaces a custom base URL.

## What it does *not* do

- It does not change message content. A `finish_reason=refusal` from Perplexity is a content-moderation decision upstream;
  the plugin only logs it.
- It does not store or read your API key.

## Requirements

- DSH `>= 0.2.1-rc.5`
- The `llm-pi-ai` provider configured with a provider id `perplexity` (or set `providerId` in the plugin config).

## Install

1. Copy this folder to your DSH profile:
   ```
   %USERPROFILE%\.dsh\profiles\<profile>\node_modules\@local\perplexity-guard\
   ```
2. Restart DSH. `cordis.patch.yml` inserts the plugin into the Cordis bundle.
3. Open the **Perplexity** sidebar page and press **Repair settings** if any finding is shown.

## Config

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn live request repair on/off |
| `providerId` | `perplexity` | Which provider id to guard |
| `defaultMaxTokens` | `32768` | Output cap used when a call has none |
| `contextWindow` | `200000` | Fallback context window when model info is unavailable |
| `headroomTokens` | `4096` | Safety margin kept free when capping output |

## Known limitation

When a request has to be rewritten (tool aliasing / schema repair), the plugin re-enters `ctx.llm.stream()` with the copy,
because the public middleware API does not expose a replacement-options `next()`. The re-entered call uses the *current*
adapter, so if you edit the provider config in the middle of a stream that one call may pick up the new settings.

## Changelog

- **1.0.3** — `perplexity_guard status` no longer emits `error: undefined`, which DSH rejected as
  "value is not lossless JSON". Doc comment fix.
- **1.0.2** — initial public version.

## License

MIT
