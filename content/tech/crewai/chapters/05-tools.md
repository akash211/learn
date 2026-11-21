# Tools and Custom Tool Integration

A tool is the only way a crew changes anything outside its own prompt. Reading a file, calling an API, querying a warehouse, opening a ticket — all of it goes through a tool, and every tool is described to the model as three things: a **name**, a **description**, and an **argument schema**. The model never sees your implementation. It chooses from the descriptions, fills the schema, and reads whatever you return.

That makes tool design the highest-leverage engineering in a crew. Agents cannot be more capable than their tools, cannot be more precise than their schemas, and cannot recover from errors you did not describe.

## Two ways to write one

Subclass `BaseTool` when the tool needs configuration, a typed schema, or state:

```python
import json
from typing import Any
from crewai.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

class OrderLookupInput(BaseModel):
    order_ref: str = Field(..., description="Order reference, format ORD-123456")
    include_lines: bool = Field(False, description="Include line items in the response")

class OrderLookupTool(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    name: str = "order_lookup"
    description: str = (
        "Look up one order by reference and return status, total, currency and dates. "
        "Use this for any question about a specific order. Returns an error object if "
        "the reference is unknown — do not retry with a guessed reference."
    )
    args_schema: type[BaseModel] = OrderLookupInput
    client: Any
    tenant_id: str

    def _run(self, order_ref: str, include_lines: bool = False) -> str:
        order = self.client.get_order(self.tenant_id, order_ref)
        if order is None:
            return '{"error": "not_found", "hint": "ask the user to confirm the reference"}'
        payload = order.to_compact_dict(include_lines=include_lines)
        return json.dumps(payload, ensure_ascii=False)[:4000]

tool = OrderLookupTool(client=api_client, tenant_id="tenant_42")
```

The `@tool` decorator covers the short cases, where a function with type hints and a docstring is enough:

```python
from crewai.tools import tool

@tool("conversion_rate")
def conversion_rate(base: str, quote: str) -> str:
    """Return the current mid-market rate for base/quote as a decimal string."""
    ...
```

Both routes produce the same contract. The difference is that `BaseTool` is a Pydantic model, so dependencies and identity can be declared as fields — which is where credentials and tenant identity belong.

## The description is the API documentation

The agent's tool-choice quality is bounded by the description. A description should say what the tool does, when to use it **instead of** the neighbouring tool, what the arguments mean, what the return looks like, and what happens on failure. Compare:

- Weak: "Searches the database."
- Strong: "Search internal support tickets by free text. Returns up to 10 tickets with id, title, status and updated_at. Use for 'has this been reported before'. Do not use for customer records — use `customer_lookup`."

The second version prevents a whole class of wrong-tool calls because it names the alternative. Models pick between similar tools badly when descriptions overlap; they pick well when each description contains an exclusion.

## Design rules that survive contact with production

**One tool, one job.** A tool with a `mode` argument that switches between search, create and delete is three tools wearing a coat, and the model will use the wrong mode.

**Narrow the arguments.** Never expose a free-form SQL string, a full URL, a file path or a shell command built from model output. Offer enumerated operations and validated identifiers instead. If a tool needs a query language, it needs a constrained one.

**Bind identity server-side.** The model must not be able to choose the tenant, user, account or environment. Pass those through the tool's constructor from the authenticated request context. A `user_id` in `args_schema` is an authorization bypass with a friendly name.

**Return less.** Tool results are pasted into the prompt. A 50,000-character JSON dump will consume the context window you needed for reasoning. Truncate, paginate, and summarise inside the tool, and return the identifiers the agent needs for a follow-up call.

**Make errors actionable.** An exception kills the run; a naked `"error"` string produces a retry loop. Return a small structured error with a category and a hint — `not_found`, `permission_denied`, `rate_limited` with a retry-after, `invalid_argument` with the expected format. Then say in the description what the agent should do about each.

**Cap the blast radius of writes.** Any tool that creates, updates, deletes, sends or pays should be idempotent (idempotency key from a stable input), should be separated from read tools, and should sit behind an approval step when the effect is irreversible. A crew that can both draft and send email needs those as two tools, not one.

## Caching, and when it lies

Tools cache by default at the agent level (`cache=True`), and individual tools can define a `cache_function` to decide what is cacheable. Caching is excellent for reference data and dangerous for anything time-sensitive: a stock level, an exchange rate or a ticket status cached from a previous run is a confidently wrong answer. For those, disable caching on the tool or in the agent, and say in the description that the value is live.

Treat caching as correctness, not performance. A cached `order_lookup` in a long-running process can return yesterday's status to today's customer.

## Scoping tools per agent and per task

Tools can be attached at three levels: the agent (`tools=[...]`), the task (`task.tools=[...]`, which limits what the assigned agent may use for that assignment), and globally through the crew's defaults. Use the narrowest level that works. A writer that never needs the payments tool should not have it, even if it never calls it — because a prompt-injected instruction can call anything the agent holds.

The same logic applies to `crewai-tools` and MCP servers. A package of forty integrations is a large attack surface and a large choice problem; attach the three the task needs. When using MCP, the server's tool descriptions become prompts you did not write, so review them and pin the server version.

## Testing tools

Test `_run` directly, as ordinary Python. Assert on the exact string the agent will see, including the truncation boundary and the error paths. Then test *tool choice* separately, with a small set of prompts and an expected tool name — that is an evaluation, not a unit test, and it belongs in the same suite that catches prompt regressions.

## Common mistakes

- **Leaking exceptions.** A stack trace in the tool result teaches the model nothing and may leak internals to the transcript.
- **Model-chosen identifiers for authorization.** Tenant, user and account come from the server.
- **Unbounded results.** Full tables, entire pages, raw API envelopes.
- **Overlapping descriptions.** Two tools that both "search documents" guarantee inconsistent routing.
- **Write tools without idempotency.** A retried `create_invoice` is a duplicate invoice.
- **Trusting tool output.** Retrieved text can contain instructions; treat it as data, never as policy.

## Production notes

Version tools with the crew, and treat a description change as a behaviour change worth reviewing. Log tool name, arguments (redacted), latency, result size and outcome per call; that log is what tells you whether a cost spike is retries, oversized results or the wrong tool being chosen repeatedly. Set timeouts inside the tool rather than relying on the agent to give up, and enforce a per-run call budget for expensive tools. Keep a read-only mode for evaluation runs, so a test cannot send an email or move money. And prefer fewer, better-described tools over a large catalogue — the model's attention over tool definitions is a finite resource, and every extra tool dilutes it.
