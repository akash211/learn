# Nodes, Triggers and the Execution Model

A workflow is a graph of connected nodes, but it is not simply a line of commands drawn on a screen. Each node declares an operation; connections route output to later nodes; trigger nodes start work from an external event, a schedule or a manual action. To debug a run, follow the execution path and inspect the items passed between nodes rather than assuming every connected node ran once.

## Node roles and connections

Common node roles include triggers, actions, transformations, control-flow nodes and sub-workflow calls. A Schedule Trigger starts on a configured interval or calendar expression. A Webhook node starts when an HTTP request reaches its registered endpoint. App-specific trigger nodes may poll a remote API or subscribe to events, depending on the integration. Action nodes include HTTP Request, database and service nodes that read or change external state. Edit Fields (formerly Set) reshapes fields; IF and Switch route items; Merge combines branches; Loop Over Items processes a batch in controlled iterations; Execute Sub-workflow invokes a separate workflow.

Names and options vary with n8n versions and node versions. The node's displayed version and current documentation matter, especially when a workflow imports an older definition. A node's output schema may differ between operations even when the node type is the same. A Google Sheets read operation and append operation, for example, are not interchangeable in their output. Read the operation description and inspect a representative execution before building expressions around presumed field names.

A connection from one node's output to another means downstream execution can be scheduled when that output is produced. Some nodes expose multiple outputs: IF has a true and false path, and an error output can route a node-specific failure when configured. Branching does not make the graph transactional. If one path writes to a service and another path fails, n8n does not roll back the successful side effect. Design compensating actions or reconciliation where partial completion matters.

## What counts as a run

A production execution normally begins at a trigger and continues through nodes enabled by the graph and the data available at their inputs. Manual execution in the editor can start from a selected node and may use pinned data from earlier steps. This is useful for iteration but can conceal a missing trigger field or stale upstream response. Before activation, test from the trigger boundary with realistic sample data and check the published workflow's behavior.

A node generally processes a list of items. If an upstream HTTP Request returns several records, the following node can receive several items and execute its operation for them. Some nodes operate once for all incoming items, while others perform work per item or expose settings such as “Execute Once.” The node's mode and version determine whether expressions resolve against a current item, all items or a linked source item. A workflow with one visible node per line may therefore issue many API calls if the input contains many items.

Execution data records what happened, subject to configuration and retention. During manual testing, the editor can show input and output for each node. Production executions may save different amounts of data based on `EXECUTIONS_DATA_SAVE_ON_SUCCESS`, `EXECUTIONS_DATA_SAVE_ON_ERROR` and related execution-data settings. Do not rely on saved payloads as the only durable business record. Pruning deletes execution records, and a success record is not a substitute for an application-level audit trail.

## Trigger lifecycle and activation

A trigger node defines how a workflow gets invoked; merely adding one does not guarantee an active production listener. In many cases, saving and activating the workflow registers the production trigger. The editor's test URL and production URL are intentionally different for Webhook. Polling triggers may run on their interval only while active. Some integrations require credentials or external event subscriptions to be registered, and some triggers are limited by upstream webhook configuration.

Activating a workflow is an operational change. It can begin polling, receive real customer traffic or perform writes. Check that the workflow is saved, that credentials and environment-specific URLs are correct, and that the intended workflow is active. Deactivating or editing a workflow can change registrations; test how the selected trigger handles outstanding events. For high-consequence actions, route a small test event or use a non-production destination before enabling general traffic.

## Branches, merges and loops

The IF and Switch nodes create conditional routes, but items do not necessarily exist on every route. A later Merge node needs a clear merge mode and input semantics. Depending on its configuration, it may append inputs, combine matching items or wait for both branches. A branch that produces no items may prevent a downstream path from running as expected. Inspect both routes and test empty, one-item and multi-item cases.

Loop Over Items is useful when the workflow must process batches in controlled chunks, use a rate limit between batches or accumulate outputs. It differs from assuming that an ordinary connection automatically forms a safe loop. The loop output and done output have different purposes; connect them deliberately and ensure the path returns to the loop node when required. A loop without a termination condition or appropriate routing can repeat work. For large inputs, batching avoids overwhelming an API, but does not alone enforce a vendor's precise rate-limit window.

Execute Sub-workflow can promote reused logic into a separately testable unit. Define the expected input fields and output shape as a contract. Be deliberate about waiting for completion, error propagation, workflow permissions and recursion. A sub-workflow boundary is an organizational aid, not an atomic transaction or a separate security boundary by itself.

## Debugging by execution evidence

When a run stops unexpectedly, inspect the execution's node status, input items, output items, and error details. Check whether a node never ran because the branch was not taken, ran with an empty input, or failed while calling an external system. Compare the run with a manual test only after accounting for pinned data, trigger source and execution mode. Look at timestamps to identify external delay, and correlate the execution with remote request IDs where the API provides them.

Node-level settings can change execution behavior. “Continue On Fail” may allow the graph to proceed but turn an error into data; this is not the same as retry. Node timeout, batching and retry options have version-specific behavior. Document the intended behavior and test the failure path, not only the green-path graph. Make node and workflow names descriptive enough that operators can identify purpose from logs and alerts.

## Common mistakes

- Assuming every node runs once, regardless of incoming item count or node mode.
- Testing only with pinned data and overlooking the real trigger's payload shape.
- Treating visual branches as transactions with rollback.
- Expecting a workflow to receive events before its production trigger is activated.
- Connecting branches to Merge without testing empty and unequal inputs.
- Using Continue On Fail as if it automatically retries or makes a failed operation safe.
