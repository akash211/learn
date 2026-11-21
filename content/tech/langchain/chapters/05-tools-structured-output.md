# Tools and Structured Output

Two related problems: getting the model to call your code with valid arguments, and getting it to return data in a shape your program can consume. Both are schema problems wearing a prompt costume. Both fail in ways that look like model misbehaviour and are almost always schema or validation gaps.

## Tools are schemas plus a description

```python
from typing import Literal
from pydantic import BaseModel, Field
from langchain_core.tools import tool

class RefundArgs(BaseModel):
    order_id: str = Field(description="Order id, format A-1234")
    reason: Literal["damaged", "not_received", "duplicate"] = Field(
        description="One of the allowed refund reasons"
    )
    amount_cents: int = Field(gt=0, le=50000, description="Refund amount, never above 50000")

@tool("issue_refund", args_schema=RefundArgs)
def issue_refund(order_id: str, reason: str, amount_cents: int) -> str:
    """Issue a refund for a delivered order. Use only after verifying the order shipped.
    Returns a confirmation id, or an error string if the order is ineligible."""
    ...
```

The decorator derives name, description, and argument schema. Three things determine whether the model uses the tool correctly:

- **The description is the prompt.** "Issue a refund" is not enough; the model needs to know when *not* to use it. Write the preconditions.
- **Constraints belong in the schema.** `Literal`, `gt`, `le` become JSON Schema enums and bounds, which the model sees and the validator enforces. A free-text `reason` field invites "customer was unhappy", which your code then rejects at runtime — after paying for the call.
- **Return strings, not exceptions, for recoverable errors.** `return "error: order already refunded"` lets the loop continue and the model adapt. Raising kills the run. Choose per tool: validation errors are recoverable, `PermissionError` is not.

## Binding tools

```python
bound = model.bind_tools([issue_refund, lookup_order], tool_choice="auto")
reply = bound.invoke("Refund A-1042, it arrived broken")
reply.tool_calls
# [{'name': 'issue_refund', 'args': {'order_id': 'A-1042', ...}, 'id': 'call_abc'}]
```

`bind_tools` translates your schema into the provider's format — OpenAI function calling, Anthropic tool use, Gemini function declarations. The translation is provider-specific and lossy in interesting ways: some providers ignore `tool_choice="required"`, some reject nested `$ref` schemas, some stringify numbers. If you support several providers, test tool binding per provider, not once.

`tool_choice` semantics:

| Value | Meaning | Support |
|---|---|---|
| `"auto"` | Model decides, may call none | Universal |
| `"required"` / `"any"` | Must call at least one tool | Provider-dependent |
| `"none"` | Tools visible, none callable | Most |
| `{"type": "tool", "name": ...}` | Force a specific tool | Some providers |

Tool invocation itself is a loop, and LangChain does not run it for you at the model layer — `create_agent` or your own loop does. That is worth internalising: `bind_tools` only makes the model *emit* calls. Executing them, appending `ToolMessage`s, and looping is orchestration.

## Structured output

For extraction and classification the model should return an object, not prose.

```python
from pydantic import BaseModel, Field

class Triage(BaseModel):
    category: Literal["billing", "bug", "feature", "other"]
    severity: int = Field(ge=1, le=5, description="1 = cosmetic, 5 = outage")
    summary: str = Field(max_length=200)

structured = model.with_structured_output(Triage)
result = structured.invoke("Checkout returns 500 for every cart over $200")
# Triage(category='bug', severity=5, summary='...')
```

`with_structured_output` uses the provider's native mechanism where one exists — JSON schema response formats, or forced tool calling — and falls back to prompt-and-parse otherwise. `method=` lets you pin the strategy (`"json_schema"`, `"function_calling"`, `"json_mode"`) when the automatic choice is wrong for your provider; `include_raw=True` returns both the parsed object and the raw message, which you want in production so a parse failure is diagnosable rather than opaque.

Why this beats `PydanticOutputParser`: the parser injects `format_instructions` into the prompt and hopes. Native structured output constrains decoding or the tool schema, so the failure rate is materially lower and the model cannot wrap the JSON in prose. The parser still has a place — self-hosted models, older providers, and cases where you need custom `format_instructions`.

```python
from langchain_core.output_parsers import PydanticOutputParser

parser = PydanticOutputParser(pydantic_object=Triage)
prompt = ChatPromptTemplate.from_messages([
    ("system", "Extract triage fields.\n{format_instructions}"),
    ("human", "{ticket}"),
]).partial(format_instructions=parser.get_format_instructions())

chain = prompt | model | parser
```

## Validation, retries, and honesty

Structured output converts a probabilistic generator into something that can still fail validation. Handle it:

- `ValidationError` from Pydantic means the model produced the wrong shape — a schema the model cannot satisfy, an enum it keeps guessing wrong, or a field with constraints it cannot see.
- Retrying once with the error text appended ("your previous answer failed validation because…") fixes most cases.
- Retrying forever does not. Bound it, and count failures: a rising rate after a model upgrade is your signal.
- Optional fields with defaults are a trap in extraction. `severity: int = 3` means the model can omit it and you get a plausible default that looks like a real judgement.

Schema design rules that measurably reduce failure: flat over nested, `Literal` over free strings, explicit units in field names (`amount_cents`), few fields per model, and descriptions that state format constraints rather than restating the field name. Enormous nested schemas with 40 fields fail far more often than four small ones.

## Streaming and structured output interact badly

Partial JSON is not valid JSON. `JsonOutputParser` handles partial dicts during `stream`, but a Pydantic-validated object cannot be constructed until the final chunk arrives. If the UI needs progress, stream the *text* channel separately or stream a simpler shape; do not expect `with_structured_output` to give you incremental validated objects.

## Tool loop safety

The model decides what to call. That is an attack surface and a cost surface.

- **Allowlist, never a dispatcher on model-supplied strings** into `eval`, `getattr`, or arbitrary imports.
- **Authorise inside the tool** using the caller's identity from config, not an argument the model can set. A `user_id` parameter the model fills in is an IDOR.
- **Idempotency keys for writes.** A retried tool call must not double-refund.
- **Timeouts and per-tool budget.** A tool that hangs stalls the whole loop; a slow tool called five times is a timeout in the making.
- **Human approval for destructive actions**, implemented as a real gate — interrupt before the node executes — not as a sentence in the system prompt.

## Common mistakes

- Vague tool descriptions, then prompt engineering to fix tool selection.
- Letting the model choose a `user_id` or tenant id.
- Raising exceptions from tools for recoverable conditions, aborting the loop.
- Assuming `tool_choice="required"` works the same on every provider.
- Trusting parsed output without validating business rules (amount ≤ order total).
- Deeply nested schemas with `$ref` cycles that some providers reject outright.

## Production notes

Log the raw tool-call arguments and the tool result for every call — that pair is the unit of debugging. Version your tool schemas alongside prompts, because changing an enum is a behavioural change. Track parse-failure and tool-error rates as first-class metrics; both spike after provider model updates, and you want to see it in a chart rather than in a customer complaint.
