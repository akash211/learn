# Performance: Forks, Pipelining, Serial and Delegation

Ansible performance is shaped by controller capacity, network latency, target behavior and the number of independent hosts. A playbook that feels slow may be waiting for SSH, fact gathering, a package manager lock, a service restart or a remote API rather than spending time in the controller. Measure the actual bottleneck before changing concurrency: running more work at once can overload managed systems or increase failure rates.

## Forks and strategies

The `forks` setting controls the maximum number of worker processes used to execute tasks across hosts. It is configured in `ansible.cfg` or overridden with `-f`/`--forks`. Raising forks may improve throughput when there are many independent hosts and controller resources are available. It can also increase memory use, SSH connection count, API calls and pressure on targets. A very high value is not automatically faster and should be tested against the real environment.

The default `linear` strategy advances hosts through tasks in lockstep: Ansible runs a task across the active hosts before advancing. `free` lets each host progress independently, which can reduce waiting for slow hosts but makes the overall timeline less synchronized. Strategy choice changes operational semantics, especially for dependent rollout steps. Use the default unless the workload benefits from independent progression and the playbook remains safe when hosts are at different stages.

Fact gathering is often an early cost. Disable it when facts are not used or use fact caching when supported and freshness rules are understood. Gathering only a subset of facts can reduce data collection. However, stale or incomplete facts can cause wrong platform branches or address choices, so performance tuning must preserve the assumptions the playbook depends on. Consider whether repeated host discovery should be replaced with carefully validated cached facts or inventory data.

## Persistent connections and pipelining

SSH multiplexing and ControlPersist can reuse connections and avoid repeated negotiation. The SSH plugin and OpenSSH configuration determine exact behavior. Verify that connection sharing works safely with the controller's user and key management. Pipelining can reduce the number of SSH operations by sending module code over the connection more efficiently; it depends on compatible target setup and may conflict with sudo configurations that require a TTY. Test it with representative modules and privilege escalation before enabling globally.

Ansible modules commonly need Python on the remote host. Very minimal systems may lack it, which can require a raw bootstrap stage or an interpreter setting. An incorrect `ansible_python_interpreter` can prevent all normal module execution. The first connection and Python discovery may cost time but should not be bypassed with unsafe ad hoc shell commands. Persistent connections are a transport optimization, not a substitute for reliable authentication and host verification.

## Serial rollout and delegation

`serial` controls how many hosts in a play are processed in batches. For example, `serial: 2` applies the play to two hosts at a time; a list of batch sizes can stage a rollout. This limits simultaneous disruption and allows a deployment to observe early results before continuing. It does not make a broken change safe, and batch sizing must match redundancy, traffic distribution and recovery capability. Combine with `max_fail_percentage` or `any_errors_fatal` when the rollout should halt after a defined failure condition. Note that strategy and handler timing influence exact rollout behavior.

`delegate_to` executes a task on another host, often `localhost` or a load balancer, while retaining the original host context in relevant variables. `run_once` runs a task once for a batch or play context depending on strategy and serial behavior; verify its scope when used with serial batches. For example, draining each application host from a load balancer before deployment can be delegated to the load balancer API. Credentials and network reachability must exist from the machine that executes the delegated task, which may be the controller rather than the original managed host.

```yaml
- name: Remove the node from the pool before maintenance
  ansible.builtin.uri:
    url: "{{ lb_api }}/pools/app/members/{{ inventory_hostname }}"
    method: DELETE
    status_code: [200, 204, 404]
  delegate_to: localhost
```

The task should model the desired membership state where possible; a raw DELETE alone may not be idempotent or appropriate for every API. Delegation and `run_once` are orchestration controls, not transaction guarantees. Include retries and health checks only when their semantics are understood, and preserve a path to return a host to service after verification.

## Async jobs and bottleneck diagnosis

Long-running tasks can use asynchronous execution with `async` and `poll`, or launch in the background with `poll: 0` and later poll using the returned job identifier. Async execution changes how results and cleanup work; it does not magically make the task safe to parallelize. Use it for work that benefits from decoupling and verify that the target operation continues when the SSH session ends. Some modules and operations have better native async behavior than arbitrary shell processes.

Use callback timing output or profiling callbacks supported by the installed version to determine which tasks consume time. Compare serial runs and realistic concurrency, inspect connection setup, and check target-side bottlenecks such as apt/dnf locks, I/O waits and service restarts. Do not invent a throughput target from a different network or fleet. Benchmark in a representative environment and record the configuration used.

`throttle` can limit the number of workers executing a particular task, which is useful when a shared API or fragile operation cannot handle the play's overall concurrency. It is task-scoped and interacts with forks and strategy, so verify its behavior in the actual play. `async` with `poll` can let the controller wait for a long-running job while controlling polling frequency; `poll: 0` launches without waiting and requires a later status check if completion matters. Remember that many independent jobs can still overwhelm a target when launched together. Add rate limits and bounded retries where the API contract supports them, and distinguish a successful launch from a successful completion. Performance options should preserve observability and correctness, not simply shorten visible wait time.
## Common mistakes

- Raising `forks` without considering controller memory, API quotas or target capacity.
- Using `free` strategy when later tasks assume all hosts reached the same stage.
- Enabling pipelining without checking TTY-dependent sudo policies.
- Using `run_once` and assuming it runs exactly once across all serial batches.
- Delegating an API call without considering where credentials and network access are available.
- Treating async launch as proof that the remote operation completed successfully.

## Production notes

Concurrency tests should include ordinary and slow hosts, because tail latency can dominate a run even when most nodes finish quickly. Track timing by task and host so a controller bottleneck can be distinguished from one failing storage system or a throttled cloud API. Avoid increasing forks to compensate for retries or timeouts caused by a network problem; doing so can amplify the load. If delegated work talks to a shared API, respect its rate limits and consider batching at that API's own semantics. For rolling deploys, calculate batch size from how many instances can be unavailable while retaining service capacity. Test the stop condition when the first batch fails, not just the success path. Keep a rollback to the previous known-good concurrency setting if an optimization changes timeouts or failure patterns.

Start with timing data. Tune forks and connection reuse in controlled steps, and keep rollout batching conservative until health checks demonstrate safety. For delegated orchestration, test failure and retry behavior with the actual API. Record relevant controller, collection and inventory versions so performance changes remain reproducible and do not become unexplained execution differences.