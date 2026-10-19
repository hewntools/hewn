# Models

Some tools think: they suggest tags, explain a word, summarise your week. Those tools call a language model themselves, through Hewn, with **your own API key**. That's separate from your coding agent, which does [Hewn's other two jobs](concepts.md#hewns-three-jobs):

| Hewn's job | Who does it | Paid by |
| --- | --- | --- |
| Writes the spec (the intake) | Claude Code or Codex on your machine | however it's signed in |
| Builds tools (the builder) | Claude Code or Codex on your machine | however it's signed in |
| Thinks inside tools | a model provider's API | your API key, metered |

Tools call models directly, not through an agent, so your Claude Code or Codex login doesn't cover them, nor does a Claude or ChatGPT subscription. Settings › AI shows all three jobs and who does each.

## Setting it up

The first time a tool asks for a model, its **Allowed to** sheet asks for a provider and a key, and a monthly budget. Pick one of:

- **Anthropic:** Claude models
- **OpenAI:** GPT models
- **OpenRouter:** many vendors with one key

Paste the key; Hewn checks it before saving. Tools never see the key. You can also add keys under Settings › AI › Models.

## Tiers

A tool asks for a **tier**, not a model, so you can change providers without rebuilding anything:

| Tier | For |
| --- | --- |
| Light | quick, cheap work: tags, short explanations |
| Standard | most work |
| Strong | harder reasoning |
| Max | the most capable |

Settings › AI › Models shows which model each tier uses on your provider, and its price. A tool's own **Model** row (Info) lets you move it to another tier.

## Spending

Hewn counts what each call costs from the provider's prices, and stops at your **monthly budget** (default is $5). Calls over the budget are refused, and the tool gets an error it can show. Settings › AI › Models shows this month's spend and lets you change the budget. A tool can have its own cap too (Info › Model).

![Settings › AI › Models: $1.21 of the $5.00 monthly budget spent, Anthropic in use with its key working, and the model and price for each tier](images/models.png)

The Inbox tells you at 80% of the budget, and when calls were refused.

When a provider retires a model a tool was pinned to, the Inbox says so.

## From the terminal

```
hewn models                          provider, tiers, budget and this month's spend
hewn models key <provider> [--from <path> | --remove]
hewn models use <provider>
hewn models tier <tier> <model-id> | --suggested
hewn models cap [<tool>] <usd> | none
hewn models set <tool> <tier>        what a tool uses
hewn models check                    test the key
```
