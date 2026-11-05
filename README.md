# DSH Perplexity Guard · Perplexity 修正器

保住 DeepSeek Harness 嘅 **Perplexity API** 路線：幫 Claude Opus 5.5、Claude Sonnet 5.5 同 GPT-6.1 Sol 補齊 output cap、避開撞名工具、修好 schema，仲可以一撳修復 provider 設定。

> Repo 名係歷史原因叫 `dsh-perplexity-api-fix-plugin`；plugin 套件名係 `@local/perplexity-guard`。

A DeepSeek Harness (DSH) Host + Web plugin that keeps the **Perplexity API** route working for Claude Opus 5.5, Claude Sonnet 5.5 and GPT-6.1 Sol, and repairs the provider settings that commonly make those calls fail.

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

- It does not change message content. A `finish_reason=refusal` from Perplexity is a content-moderation decision upstream; the plugin only logs it.
- It does not store or read your API key.

## Requirements

- DSH `>= 0.2.1-rc.5`
- The `llm-pi-ai` provider configured with a provider id `perplexity` (or set `providerId` in the plugin config)
- A Perplexity API key configured in that provider

## Install

1. Clone or download this repo.
2. Install the folder as a bundle in DSH:

   ```text
   plugin_manager(action: "install_bundle", target: "C:\\path\\to\\dsh-perplexity-api-fix-plugin")
   ```

3. Restart DSH.
4. Open the **Perplexity** sidebar page and press **Repair settings** if any finding is shown.

## Config

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn live request repair on/off |
| `providerId` | `perplexity` | Which provider id to guard |
| `defaultMaxTokens` | `32768` | Output cap used when a call has none |
| `contextWindow` | `200000` | Fallback context window when model info is unavailable |
| `headroomTokens` | `4096` | Safety margin kept free when capping output |

## Known limitation

When a request has to be rewritten (tool aliasing / schema repair), the plugin re-enters `ctx.llm.stream()` with the copy, because the public middleware API does not expose a replacement-options `next()`. The re-entered call uses the *current* adapter, so if you edit the provider config in the middle of a stream that one call may pick up the new settings.

## Changelog

- **1.0.3** — `perplexity_guard status` no longer emits `error: undefined`, which DSH rejected as "value is not lossless JSON". Doc comment fix.
- **1.0.2** — initial public version.

## 同系列 DSH 插件

| 插件 / Plugin | 功能 / What it does | 要唔要裝埋 / Also install | Repo |
|---|---|---|---|
| **Attention Center** | 側欄通知收件箱：任務完成、待核准、新問題會閃，系統允許時出桌面通知<br>Sidebar inbox with a flashing icon and optional desktop notifications | 唔使 / None | [dsh-attention-center](https://github.com/Kinfxhk/dsh-attention-center) |
| **Computer Use** | 側欄「電腦」頁：Agent 可以睇窗、click、打字、按鍵、捲動（隨時可以熄）<br>Computer page where the agent observes and operates windows | 要：Windows + Cua driver<br>Yes: Windows + Cua driver | [dsh-computer-use](https://github.com/Kinfxhk/dsh-computer-use) |
| **Model Senses** | `model_senses`：睇圖＋上網搜尋，跟住即時預設 API<br>Vision and web-search tools routed through the live default API | 唔使（用已連線 API）<br>None (uses configured APIs) | [dsh-model-senses](https://github.com/Kinfxhk/dsh-model-senses) |
| **Model Shelf** | 側欄模型架：按 API 篩選、收藏、一撳套用<br>Sidebar shelf to filter, bookmark, and apply models | 唔使 / None | [dsh-model-shelf](https://github.com/Kinfxhk/dsh-model-shelf) |
| **Perplexity Guard** | 修正 Perplexity 嘅 Opus／Sonnet 5.5、GPT-6.1 Sol 請求同 provider 設定<br>Fixes Perplexity requests and provider settings | 要：Perplexity API key<br>Yes: Perplexity API key | [dsh-perplexity-api-fix-plugin](https://github.com/Kinfxhk/dsh-perplexity-api-fix-plugin) |

## License

MIT
