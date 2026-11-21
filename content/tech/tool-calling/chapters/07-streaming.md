# Streaming Tool Arguments and Results

Streaming exists because two things are slow and only one of them is the model. Users tolerate a slow answer if they can see it being written; they do not tolerate a blank screen followed by a 40-second silence while a tool runs. Streaming tool calls adds a second problem: the arguments arrive in fragments, and it is tempting to act on them too early.

## Three streams, not one

Keep them conceptually separate, because they have different trust levels and different consumers:

| Stream | Producer | Consumer | Trust |
|---|---|---|---|
| Assistant text | Model | User, incrementally | Untrusted |
| Tool arguments | Model | Your dispatcher, *when complete* | Untrusted until validated |
| Tool execution progress | Your tool | User (and possibly the model) | Trusted-ish, still sanitise |

Most implementations muddle the first two because both arrive over the same HTTP response. The third is usually bolted on later, when a tool takes eight seconds, and it is where the design decisions live.

## How arguments arrive

**OpenAI Chat Completions** streams an assistant delta whose `tool_calls` array is keyed by `index`. The first chunk for a call carries `id`, `type`, and `function.name`; subsequent chunks carry only `function.arguments` string fragments, which must be concatenated in order:

```
delta.tool_calls[0] = {"index": 0, "id": "call_abc", "function": {"name": "search_orders", "arguments": ""}}
delta.tool_calls[0] = {"index": 0, "function": {"arguments": "{\"email\":"}}
delta.tool_calls[0] = {"index": 0, "function": {"arguments": "\"a@ex"}}
delta.tool_calls[0] = {"index": 0, "function": {"arguments": "ample.com\"}"}}
finish_reason = "tool_calls"
```

**Anthropic Messages** streams a `content_block_start` for each `tool_use` block (carrying `id`, `name`, and an empty `input`), then `content_block_delta` events with `delta.type: "input_json_delta"` and a `partial_json` string, then `content_block_stop`, and finally `message_delta` with `stop_reason: "tool_use"`.

In both cases the invariant is the same: **arguments are meaningless until the block closes**. A partial `{"email": "a@ex` is not a JSON object with a truncated string; it is a prefix. Do not parse it, and above all do not execute it.

If you need to display progress, accumulate and render a *preview* clearly marked as in-progress, and never send it to a tool. If you must inspect partial arguments (for example, to show "looking up order ord_88…"), use an incremental JSON parser that emits key/value pairs as they complete, and accept that values can still change.

Multiple parallel calls interleave in the same stream, distinguished by `index` on OpenAI and by content block index on Anthropic. Accumulate into a map keyed by that index, not by arrival order, and keep the ID with its buffer — the ID arrives on the first fragment only, so a naive "append to the last buffer" loop will merge two calls into one.

## Execute at the boundary

```python
buffers: dict[int, dict] = {}

for event in stream:
    if event.type == "tool_call_delta":
        buf = buffers.setdefault(event.index, {"id": None, "name": None, "args": []})
        buf["id"] = buf["id"] or event.id
        buf["name"] = buf["name"] or event.name
        if event.arguments_fragment:
            buf["args"].append(event.arguments_fragment)

    if event.type == "message_stop" or event.finish_reason == "tool_calls":
        calls = [
            ToolCall(id=b["id"], name=b["name"], arguments="".join(b["args"]))
            for _, b in sorted(buffers.items())
        ]
        results = dispatcher.execute(calls, principal)   # validate → authorise → run
```

Execution at the boundary is the only safe point. Execute after the stream ends for that turn: the user waits for the model to finish before the first tool starts, and that is correct, because you cannot know whether more fragments are coming. Optimise by validating arguments as soon as the block closes and preparing the next request in parallel — never by executing early, and never by starting the next model call before all results for the turn are in, which would leave the transcript malformed.

## Streaming tool output back

A tool that takes 15 seconds needs feedback. There are four honest options, and one dishonest one.

**Status only, to the user.** "Searching 3 systems…" is cheap, needs no protocol change, and is invisible to the model. Best default.

**Streaming output to the user's UI, not the model.** The tool yields chunks over your own event channel (SSE, WebSocket) tagged with the `tool_call_id`. The user watches rows appear; the model later receives the final, compact result. This keeps the context clean and avoids injecting partial, unvalidated content into the prompt.

**Long-running handle.** Return immediately with `{"ok": true, "operation_id": "op_123", "status": "running"}`; the model can poll via a second tool, or the UI subscribes to the operation. This is the right pattern for anything over ~30 seconds, because holding a model turn open has its own timeout.

**Streaming into the model's context.** Some providers support feeding tool output back incrementally, and server-side tools stream their own results inside the response. This is provider-specific; do not assume parity. Where it exists, it is genuinely useful for long outputs the model must reason over, but you lose the chance to sanitise the whole result before it enters the context — which is a security regression if the source is untrusted.

The dishonest option is fabricating progress. Do not invent "50% complete". Users notice, and it destroys trust in the tool's real signals.

## Protocol design for the client

Whatever transport you choose, the event schema should be boring and complete:

```
event: tool_call_start    data: {"index":0,"id":"call_abc","name":"search_orders"}
event: tool_args_delta    data: {"index":0,"fragment":"{\"email\":"}
event: tool_call_ready    data: {"index":0,"args_hash":"9f2c…"}
event: tool_result        data: {"id":"call_abc","ok":true,"summary":"4 orders","bytes":812}
event: assistant_delta    data: {"text":"I found four orders…"}
event: run_done           data: {"steps":3,"status":"ok"}
```

Give every event a monotonically increasing `seq` and the run a `run_id`. That makes reconnection possible: the client reconnects with the last `seq` and the server replays from a short buffer, instead of the UI losing half a tool result and rendering a lie. Include a `summary` in the result event; UIs should not render the raw payload that the model receives.

Proxies close idle connections. If a tool can run 60 seconds with no output, send a comment-style heartbeat every 15 seconds and set the server's write timeout above it.

## Cancellation

A user who cancels must actually cancel work, not just close the browser tab. Propagate cancellation to: the model HTTP request, the tool execution (a real cancel token or process kill), and the loop, so no further steps run. Record what was already committed — a cancelled run that had already issued a refund is a completed effect, and the UI must say so rather than showing "cancelled".

Tools that cannot be cancelled (a third-party POST) need idempotency keys from chapter 4 so a retry after cancellation does not duplicate. Cancellation is a stop signal, not a rollback.

## Common mistakes

- Parsing each fragment as JSON, or validating only the first fragment.
- Executing on the first `}` in the argument stream, which is a nested object's brace.
- Keying buffers by arrival order instead of `index`, merging parallel calls.
- Losing the `id`, which arrives only on the first fragment, and therefore being unable to attribute results.
- Sending partial or unvalidated tool output into the model's context.
- Streaming the raw tool payload to the user while the model gets a summary, so the two disagree.
- Fabricated progress percentages.
- No heartbeat, so a proxy kills a long tool call and the client shows a spinner forever.
- Treating cancellation as rollback.

## Production notes

Measure time-to-first-token and time-to-first-tool-result separately; they have different fixes, and conflating them sends you optimising the wrong thing. Track abandoned streams (user navigated away) and their associated tool executions — orphaned work is a real cost.

Replay a recorded stream in tests: feed the same fragment sequence and assert the reconstructed arguments equal the non-streamed payload. Fragment boundaries are arbitrary, including inside escape sequences (`\u00e9` split across chunks), unicode surrogate pairs, and multi-byte UTF-8 — if you decode fragments as bytes rather than as text, you will corrupt non-ASCII arguments in a way that only shows up for some users.
