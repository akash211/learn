# Operating Kafka: ISR, Under-Replicated Partitions and Capacity

Kafka operations are a balancing act among availability, durability, latency, and recovery. A cluster can appear healthy while losing replica redundancy, accepting only some writes, or accumulating consumer lag. Operators need to understand partition leadership and replication state before responding to alerts: “broker up” is not the same as “data safely replicated,” and “all partitions have a leader” is not the same as “all replicas are healthy.”

## ISR and partition health

Each partition has a leader and followers. The **in-sync replicas (ISR)** are replicas sufficiently caught up with the leader according to the cluster's replication rules. A healthy partition typically has its expected replicas in the ISR. If a follower falls behind beyond `replica.lag.time.max.ms`, it may be removed from the ISR; if it catches up again, it can rejoin. The current ISR determines what `acks=all` means for a write, together with `min.insync.replicas`.

An **under-replicated partition** has fewer replicas caught up than the desired replication factor. This is a warning of reduced fault tolerance even if the leader is currently serving clients. A partition with no leader is unavailable for normal operations until leadership is restored. A partition with a leader but too few ISR members may reject writes when the minimum ISR requirement cannot be met. Do not “fix” this by lowering `min.insync.replicas` without explicitly accepting the durability tradeoff.

Investigate where the affected replicas live and whether the cause is broker-wide or concentrated. Check broker disk latency and capacity, network throughput and packet loss, GC pauses, request queues, replica fetcher errors, throttling, and whether maintenance or reassignment is in progress. A slow disk can make one follower fall out of ISR; repeated leadership changes can then make the whole workload unstable. The alert indicates replication health, not the root cause.

## KRaft controller quorum

In KRaft mode, cluster metadata is maintained by a Raft-based controller quorum, separate from the replicated data logs. Controllers handle metadata changes such as topic creation, partition reassignment, and broker membership. Losing a controller quorum can prevent metadata operations even while existing leaders continue to serve some traffic. Deploy controllers across failure domains according to the supported topology and monitor quorum health, metadata log replication, and controller request latency.

Kafka 4.0 is the first major release without ZooKeeper; it operates in KRaft mode. Older versions may run with ZooKeeper or KRaft depending on release and migration state. Upgrade planning must follow the exact supported path for the current cluster; ZooKeeper-to-KRaft migration is not simply “change a config and restart.” Kafka 3.9 was the final major 3.x line and the bridge for migration before 4.0 removed ZooKeeper support. Dynamic KRaft controller quorum membership also arrived in the 3.x era, but procedure and limitations vary with the initial quorum format and release. Read version-specific runbooks before altering controller membership.

## Reassignment and rebalancing

Partition reassignment moves replicas among brokers to restore balance, remove a broker, or change replication placement. It consumes network and disk I/O and can compete with produce/fetch traffic. Limit reassignment concurrency and throttle replication when necessary, but measure how throttling affects time to restore redundancy. A reassignment that runs forever leaves capacity and fault-tolerance assumptions unresolved; one that runs too aggressively can degrade client latency.

Avoid confusing **partition reassignment** (moving replicas among brokers) with **consumer group rebalance** (assigning partitions to consumers). They have different control paths and symptoms, although both can happen during a broker change. A broker bounce may cause leaders to move and clients to refresh metadata, while consumer membership changes can trigger group coordination. Correlate timestamps across broker and client metrics rather than treating every lag increase as a single mechanism.

## Capacity planning

Capacity includes more than disk. Plan for retained bytes multiplied by replication, indexes and segment overhead, peak ingest, consumer fetches, compaction, remote storage, recovery traffic, and headroom for node loss. CPU is spent on TLS, compression, request handling, replication, and log cleaning. Network is used by producers, consumers, followers, and reassignment. Disk throughput and page cache affect tail reads and cold replay. A cluster that is full in one dimension cannot be repaired by adding capacity in another.

Partition count affects broker metadata, open files, leader distribution, and recovery time. Each additional partition has overhead even when idle. Too few partitions limit parallelism and create large recovery units; too many increase control-plane and file-management overhead. Evaluate the expected consumer parallelism, key distribution, message size, retention, and failure recovery objective. There is no universal “partitions per broker” rule that replaces a measured workload test.

For capacity forecasts, use observed bytes and request rates from representative peaks. Include replication factor and growth over the retention window. For consumer throughput, measure records and bytes per second per partition and account for skew: a single hot key can be the limiting factor. A throughput number without payload size, compression, durability settings, and workload mix is not a portable capacity claim.

## Rebalance storms and client health

Frequent consumer group rebalances may coincide with broker load but often originate in client processing or deployment behavior. Check `max.poll.interval.ms`, `session.timeout.ms`, heartbeat behavior, GC pauses, blocked downstream calls, crash loops, subscription changes, and rolling-deploy concurrency. More consumers do not fix a rebalance storm; they can make it worse by increasing membership churn. Tune graceful shutdown and deployment surge so only a controlled fraction of members leave at once.

## Reassignment and incident response

When a broker is lost, first determine whether partitions still have leaders, whether their ISR can satisfy the durability policy, and whether the failed broker's replicas are recoverable. Reassignment may restore the intended replica layout, but it is a data-movement operation with real load. Establish a target concurrency and throttle, communicate expected effects on client latency, and watch both the moving replicas and the partitions that remain under-replicated. Do not start multiple corrective actions that compete for the same disk and network before measuring the first one's impact.

Capacity headroom is what lets routine maintenance and unexpected failure coexist. If every broker is already close to its disk or network limit, adding replicas can worsen the overload before it improves safety. Include one-broker loss in capacity models, check that leaders distribute sensibly, and verify the controller quorum survives the same failure scenario. Runbook steps should say when to stop or roll back a reassignment, who authorizes a temporary durability downgrade, and how to verify that all replicas have returned to the intended state.

## Common mistakes

- Treating under-replication as a minor dashboard warning because a leader exists. Redundancy is already reduced.
- Lowering `min.insync.replicas` to clear write errors without communicating the durability tradeoff.
- Restarting brokers repeatedly before checking disk, network, and replica fetcher health.
- Running a large reassignment without throttling or without measuring client impact.
- Mixing up consumer rebalances with replica reassignment.
- Planning storage as raw topic bytes while forgetting replicas, indexes, compaction and recovery headroom.

## Production notes

Maintain dashboards for offline and under-replicated partitions, ISR shrink/expand events, leader elections, request latency, disk usage and latency, network utilization, controller quorum health, consumer lag, and rebalance rate. Alerts should distinguish “redundancy reduced” from “writes unavailable” and page according to the business objective. Keep tested runbooks for broker replacement, disk failure, controller loss, replication-factor changes, credential or certificate rotation, and version upgrade. Practice recovery with production-like data volume: restoring a cluster is a data-movement event, and the time required is often more important than the nominal replication setting.