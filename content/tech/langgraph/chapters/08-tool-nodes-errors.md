# Tool Nodes and Error Handling

A tool call is an external capability: reading a record, querying a search index, creating a ticket, or performing some other operation. LangGraph represents tool use as part of graph control flow. The model may request a tool, the graph executes an allowed tool node, and the result can be returned to a model or another node. The important distinction is that a model proposes a call; application code authorizes and executes it. Never let untrusted model output directly execute arbitrary code or select unrestricted credentials.

For LangChain tools, `ToolNode` is a ready-made node that executes tool calls represented in model messages and produces tool results. A common message-based agent uses `MessagesState` or a custom state with an `add_messages` reducer, then routes from the model node to the tool node when the assistant message contains tool calls. A model bound to tools can be invoked in an LLM node, but the binding itself does not run the tool; graph routing and the tool node do.

## Tool boundary and validation

Define each tool's name, description, input schema, permissions, timeout, and side-effect behavior. Validate arguments before execution, enforce tenant and user authorization outside the model, and constrain network or filesystem access to the minimum scope. A model can hallucinate an argument or be influenced by malicious content found in a document. Treat retrieved text as data, not trusted instructions, and never grant tools broad access just because a model is expected to behave.

Separate read-only tools from effectful tools. Read-only operations are often safer to retry, though they may still leak data or incur cost. A tool that sends a message, modifies a ticket, or charges an account requires an idempotency plan, authorization, and often approval. Record the intended action and the tool result, but do not assume the graph checkpoint and the external system update share a transaction.

Tool results should be bounded and shaped for the next node. Returning a huge API payload can inflate messages, checkpoints, traces, and model context. Extract the fields needed downstream, preserve source identifiers, and summarize without losing provenance. Handle empty results and partial responses explicitly.

## Error taxonomy and recovery

Different errors call for different graph behavior. A transient network failure may be retried with bounded backoff. A rate limit may require waiting, retrying after the provider's instruction, or switching to a safe fallback. A validation error should normally be returned as a structured tool error so the model can correct arguments, subject to a small attempt limit. An authorization failure should not be retried by asking the model to try a different identity. A permanent not-found condition may route to clarification or terminate with a useful result.

Node-level retry policies are for exceptions that should cause a node invocation to be attempted again. They are not the same as tool-call loops. A model can respond to a tool error and choose a corrected call; that is a successful workflow step whose output drives another transition. Retry only selected exception classes and ensure the node can safely run again. If the external service may have applied the action before returning an error, use a stable idempotency key and query for the existing outcome before repeating.

When errors are returned as state rather than raised exceptions, make the contract explicit. A tool result can contain a structured `ok`, `error_code`, and `retryable` field, but avoid exposing secrets or internal stack traces to the model or end user. Log the detailed cause in a protected system and send a concise, non-sensitive summary through the graph.

## ToolNode routing example

The following snippet shows the common shape with LangChain tools. It depends on the corresponding `langchain` integration package and a configured model provider; no provider output is fabricated here. The graph builder, routes, and `ToolNode` are current API patterns. Pin tested package versions in the application because integrations and model-specific tool calling evolve.

```python
from typing import Literal
from typing_extensions import TypedDict, Annotated
from langchain_core.messages import AnyMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]

@tool
def lookup_status(ticket_id: str) -> str:
    """Return the status of an authorized support ticket."""
    # A real implementation must check the caller's tenant and permissions.
    return f"Status lookup requested for {ticket_id}"

tools = [lookup_status]
tool_node = ToolNode(tools)

def call_model(state: AgentState) -> dict:
    # `model` is a configured chat model with tools bound in application setup.
    response = model.bind_tools(tools).invoke(state["messages"])
    return {"messages": [response]}

def route_after_model(state: AgentState) -> Literal["tools", "end"]:
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else "end"

builder = StateGraph(AgentState)
builder.add_node("model", call_model)
builder.add_node("tools", tool_node)
builder.add_edge(START, "model")
builder.add_conditional_edges(
    "model", route_after_model, {"tools": "tools", "end": END}
)
builder.add_edge("tools", "model")
agent = builder.compile()
```

The `model` symbol is intentionally supplied by the application; selecting a provider and credentials depends on the deployment. The loop must have a task-level budget or other stop policy in production. A tool's docstring and schema help the model formulate a call, but server-side validation and authorization remain mandatory. If a tool node executes calls concurrently, make sure each tool is independently safe and each result can be merged into message state.

## Human approval for effectful tools

If a model proposes a consequential action, place a review boundary before execution. The graph can build an action proposal, call `interrupt()` with a human-readable payload, and only route to a tool node after a valid approved response. Bind the approval to a canonical representation of the proposed action; if arguments change after approval, request approval again. Use an idempotency key for the eventual effect and store the result independently so resumed execution does not duplicate it.

## Common mistakes

- **Assuming a tool schema provides authorization.** It constrains arguments, not who may access the underlying data.
- **Returning raw exceptions to the model.** Expose a safe error category; keep sensitive details in protected logs.
- **Retrying effectful calls without an idempotency key.** A timeout does not prove the operation failed.
- **Letting tool output grow without bounds.** Filter, truncate safely, or summarize while preserving evidence references.
- **Routing based only on natural-language text.** Inspect structured tool-call metadata, then validate it.

## Production notes

Apply per-tool deadlines and concurrency limits, and isolate slow or unreliable dependencies. Track tool call counts, success rates, error categories, and latency by tool and tenant without leaking arguments into metrics. Build mock-tool tests for malformed inputs, permission denial, timeouts, and duplicate requests. Keep tool manifests and graph code versioned together so a changed description or argument schema does not silently alter behavior for active threads.
