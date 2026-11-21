# The Log, Partitions, Offsets and Segments

Kafka becomes easier to reason about once it is understood as a distributed commit log, not a queue of objects that disappear when one consumer reads them. A producer appends records; brokers persist ordered byte sequences; consumers choose positions and fetch records. The log is immutable in the ordinary path: records are appended, not edited in place. Retention or compaction later removes eligible data. This separation between writing and reading is why multiple independent applications can replay the same history at different speeds.

## From topic to record

A **topic** is a named stream, such as `orders`. It is divided into one or more **partitions**, each an ordered log. A record contains a key, value, timestamp, headers, and metadata such as its offset; key and value may be null. Ordering is guaranteed within a partition, not across all partitions of a topic. A topic with several partitions is therefore a set of ordered histories, not one globally ordered list.

Kafka distributes partitions among brokers. One replica is the **leader** for a partition and handles writes and ordinary reads; follower replicas fetch from it and maintain copies. A client sends metadata requests to learn current leaders and can refresh that metadata after a leader change. Replication is about availability and durability, not additional read capacity by default: Kafka's normal consumer protocol routes reads to the leader, although some deployments support carefully configured follower fetching.

The unit of ordering, replication, and consumer-group parallelism is the partition. That fact connects design choices which are often treated separately: key selection determines which partition receives a record, partition count bounds active consumers in a traditional group, and partition placement determines storage and recovery work.

## Offsets are positions, not row numbers

Within each partition, Kafka assigns records monotonically increasing offsets. An offset identifies a position in that partition's log; it is not a promise that every integer corresponds to a visible record. Compaction can remove records while preserving later offsets, and transactional records that are aborted are hidden from `read_committed` consumers. A consumer's offset is therefore a bookmark, not a count of how many business events exist.

There are several useful positions. The **log start offset** is the earliest position still available locally or under the topic's storage policy; the **log end offset** is the next offset after the last appended record. The high watermark indicates the boundary of data replicated sufficiently to be visible to ordinary consumers. With transactions, the **last stable offset** can be lower than the high watermark while an earlier transaction remains open. A `read_committed` consumer does not read beyond that stable boundary, because doing so could expose data whose transaction outcome is undecided.

Consumer-group committed offsets are stored separately from the record log, in Kafka's internal `__consumer_offsets` topic. The committed offset convention is usually the **next** record to consume. If an application processes record 41 and commits 42, it asks to resume at 42. The distinction matters when debugging, resetting a group, or implementing manual commits: commit too early and a crash can lose work; commit too late and records may be processed again.

## Segments and indexes

A partition is physically represented as a sequence of **log segments** on broker storage. The active segment receives new appends. When a configured size or time threshold is reached, Kafka rolls to a new segment. Older segments become eligible for retention or compaction according to topic configuration. This chunking avoids rewriting a whole partition when a small range expires and bounds the scope of index and recovery work.

A segment is accompanied by index files that help Kafka locate an offset or timestamp without scanning every record. The offset index is sparse: it maps selected offsets to file positions, and the broker scans a short range from the index entry to the requested record. Timestamp lookup uses a time index, while transaction-related index data supports filtering of aborted transactional records. Indexes can be rebuilt from the log if necessary; the record log remains the source of truth.

The active log is append-oriented, and broker page cache is important to read performance. Kafka does not require every consumer read to issue a physical disk read: recently written and frequently fetched pages may already be cached by the operating system. A conceptual mental model of “one disk read per message” leads to poor sizing conclusions. Conversely, a restart or a cold read of old data can behave differently from steady tailing, so test both.

## Replication and visibility

Each partition has a replication factor, for example three copies across brokers. Followers fetch from the leader and track its log. The **in-sync replica (ISR)** set contains replicas considered sufficiently caught up under the broker's replication rules. With `acks=all`, the leader acknowledges a write after the required ISR condition is satisfied; `min.insync.replicas` can reject writes when too few replicas are available rather than silently accepting a less durable write. The precise acknowledgment boundary depends on the topic and broker configuration, not on the phrase “three copies” alone.

The high watermark is advanced based on replication progress, and ordinary consumers generally see records only below it. This prevents a consumer from observing data that could disappear if the leader failed before followers replicated it. Producer acknowledgments and consumer visibility are related but not identical concepts: producer `acks` determines when the producer receives success; replication and high-watermark rules determine what is safely readable.

## Common mistakes

- Treating a topic as globally ordered. If two records map to different partitions, there is no total order between them.
- Treating offsets as dense sequence numbers or as timestamps. Use record timestamps or timestamp lookup APIs when time semantics matter.
- Assuming a committed offset means the corresponding business operation committed. Kafka stores consumer progress; an external database transaction is separate unless the application coordinates them.
- Using partition count as a proxy for throughput. Partition count enables parallelism, but brokers, network, storage, serialization, downstream systems, and hot keys still constrain the system.
- Assuming replication factor alone guarantees a successful durable write. Acknowledgment settings and the current ISR must be considered together.

## Production notes

Inspect partition leaders, replicas, and log start/end offsets when a consumer reports lag. Lag is often computed as a difference between end position and committed or current position; it is an offset distance, not necessarily a count of unprocessed business records or a duration. Convert it to time only with an observed arrival/processing rate, and account for compaction and transactional visibility.

Plan partitions before production. Increasing a partition count changes key-to-partition mapping for many partitioners and can alter ordering for a key over time. It is not a transparent capacity knob for every keyed workload. Choose a key that expresses the ordering boundary, estimate storage and recovery behavior, and document how offsets are reset and retained. A log is valuable precisely because it can be replayed; make replay permissions and the business consequences of replay explicit.