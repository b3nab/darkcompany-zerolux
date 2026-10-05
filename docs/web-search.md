# Web search for pi

The pi extension `extensions/pi/src/web-search.ts` (loaded from `.pi/extensions/web-search.ts`) adds two tools, `web_search_claude` and `web_search_codex`. Each runs the CLI you already have, `claude` or `codex`, with its built-in web search: no search API and no extra key. Each call is a model run billed to the account the CLI is signed in with.

| Parameter     | Values                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------- |
| `query`       | What to search or research                                                                  |
| `mode`        | `quick` (default) or `research`                                                             |
| `model`       | Model for the CLI, e.g. `sonnet` or `opus`; the CLI default if omitted                      |
| `effort`      | Claude: `low` `medium` `high` `xhigh` `max`. Codex: `minimal` `low` `medium` `high` `xhigh` |
| `max_results` | Results in quick mode, default 8                                                            |

**Quick** returns an answer with inline source links and a list of results (title, URL, snippet). It times out after 2 minutes.

**Research** writes a Markdown report with sections and numbered sources to `.zerolux/research/<date>_<provider>_<slug>.md` and returns its path and opening. It times out after 10 minutes.

Each call runs in an empty temporary directory, without the project's files or instructions, with only the web search and fetch tools. While it runs, pi shows each search and page fetch; cancelling the pi turn stops it.

`bun test extensions/pi` covers both tools with a fake CLI.
