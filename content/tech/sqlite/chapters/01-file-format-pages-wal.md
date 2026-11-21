# File Format, Pages and the Write-Ahead Log

A SQLite database is a file with a 100-byte header and a sequence of equally sized pages. That
is the whole storage engine at the top level: no tablespace, no segment, no free-space map kept
in a separate file. Everything the engine does — reading a row, adding an index, reclaiming space
— is a change to a page in that sequence, recorded either in a rollback journal or a write-ahead
log so it can be undone or redone.

## The header tells you what the file is

Open any SQLite file with `xxd` and the first 16 bytes are the string `SQLite format 3` followed
by a NUL. The rest of the header is fixed-layout integers in big-endian order:

| Offset | Size | Field |
| --- | --- | --- |
| 16 | 2 | Page size in bytes; the value `1` means 65536 |
| 18 | 1 | File format write version (`1` rollback journal, `2` WAL) |
| 19 | 1 | File format read version |
| 21 | 3 | Max embedded payload fractions: 64, 32, 32 |
| 28 | 4 | Database size in pages |
| 32 | 4 | First freelist trunk page |
| 36 | 4 | Number of freelist pages |
| 40 | 4 | Schema cookie — bumped by every DDL change |
| 44 | 4 | Schema format number (4 in current files) |
| 56 | 4 | Text encoding: 1 UTF-8, 2 UTF-16le, 3 UTF-16be |
| 60 | 4 | `user_version` — yours to use |
| 68 | 4 | `application_id` — identifies the file's producer |
| 96 | 4 | SQLite version that last wrote the file |

The header is not just metadata: page 1 also contains the root of `sqlite_schema` (the table
listing every table, index, view and trigger), which is why page 1's b-tree header starts at byte
100 rather than byte 0. Dump the first byte of each page and you get the page type: `0x0d` for a
table leaf, `0x0a` for an index leaf, `0x05` table interior, `0x02` index interior. On page 1 you
see `0x53` (`S`) because the header is in the way.

```bash
$ xxd -l 32 app.db
00000000: 5351 4c69 7465 2066 6f72 6d61 7420 3300  SQLite format 3.
00000010: 1000 0101 0040 2020 0000 0003 0000 0003  .....@  ........
```

That is a 4096-byte page size (`0x1000`), rollback-journal versions, and a three-page database.

## Inside a page

A b-tree page begins with an 8-byte header (12 on interior pages): page type, offset of the first
freeblock, number of cells, start of the cell content area, and a count of fragmented free bytes.
Then comes an array of 2-byte cell pointers growing forward from the header, while cell content
grows backward from the end of the page. A cell is a varint key plus a payload; on a table page
the key is the `rowid`, on an index page it is the indexed values encoded as a record.

Records are self-describing. The payload starts with a header of serial types — one varint per
column — followed by the values. Serial type `0` is NULL, `1`–`6` are integers of 1, 2, 3, 4, 6
and 8 bytes, `7` is an IEEE-754 double, `8` and `9` are the constants 0 and 1, and values of 12
and above are blobs or text with the length encoded in the serial type. This is why SQLite can
store a value without knowing the column type: the type travels with the value, in the record.

```sql
CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);
INSERT INTO t(v) VALUES('hello');
SELECT typeof(v), length(v) FROM t;
```

`id INTEGER PRIMARY KEY` is special: it is not a separate column but an alias for the rowid, so
the table is keyed by that integer with no second lookup. Any other primary key (or `UNIQUE`)
needs a separate index b-tree whose entries point back at the rowid. `WITHOUT ROWID` tables skip
that indirection by making the primary key the table key itself — one page read instead of two,
at the cost of larger keys and no rowid.

When a row is too big for its page, the payload pointer spills into a chain of overflow pages.
The local threshold is about `page_size - 35` bytes for table leaves; the remainder is stored in
pages whose first four bytes point at the next page in the chain. A 1 MB blob is therefore a
linked list of ~250 pages for a 4 KB page size — reading it is sequential, but deleting it
leaves those pages on the freelist rather than shrinking the file.

## The two journals

Before a page is modified in rollback-journal mode, its original content is written to a `-journal`
file beside the database. If the process dies mid-commit, the next connection sees the journal,
rolls the original pages back, and the database is consistent again. Committing means deleting
or truncating the journal — the moment of atomicity is a filesystem operation, which is why
SQLite's durability is tied to `fsync` and directory-entry semantics.

WAL mode inverts this. Changes are appended to a `-wal` file as frames: a 24-byte frame header
(page number, database size after commit, salts, checksums) followed by the page image. A commit
is a frame with a non-zero database-size field; recovery replays frames up to the last valid
commit. Readers consult a `-shm` shared-memory wal-index to find the latest version of a page
without scanning the WAL. Periodically a checkpoint copies frames back into the main database
file, and the WAL can then be reused or truncated.

```sql
PRAGMA journal_mode = WAL;      -- persistent; stored in the file header
PRAGMA wal_autocheckpoint = 1000;  -- pages; default
PRAGMA wal_checkpoint(TRUNCATE);   -- returns (busy, log_frames, checkpointed_frames)
```

The consequences are not cosmetic. In WAL mode the `.db` file lags behind the truth and may be
missing recent commits; a copy of the `.db` alone is not a backup. In rollback mode a writer must
wait for readers at commit time, because it needs an exclusive lock to overwrite pages in place.
That single difference explains most of the concurrency advice in the next chapter.

## Free pages, VACUUM and the shape of the file

Deleting rows does not shrink the file. Pages that become empty are put on a freelist — a linked
list of trunk pages, each holding pointers to leaf pages — and reused by later inserts. You can
see the accounting directly:

```sql
PRAGMA page_count;       -- total pages
PRAGMA freelist_count;   -- pages available for reuse
PRAGMA page_size;
SELECT name, count(*) AS pages, sum(pgsize) AS bytes
FROM dbstat GROUP BY name ORDER BY bytes DESC;
```

`VACUUM` rewrites the database into a new file, dropping free pages and defragmenting the rest;
it needs free disk equal to the database size and holds a write lock for the duration.
`PRAGMA auto_vacuum = INCREMENTAL` (which must be set before the first table is created, or
enabled with a `VACUUM`) lets you return pages a few at a time with
`PRAGMA incremental_vacuum(N)` instead.

## Production notes

- Page size is fixed at creation. Set `PRAGMA page_size = 8192` (or 16384) *before* the first
  `CREATE TABLE` on files that will hold large blobs or long text, then `VACUUM` to apply it to an
  existing file. 4096 is the default and is fine for most OLTP.
- `PRAGMA application_id` and `PRAGMA user_version` are the supported way to mark a file's
  producer and schema version. Use them instead of a metadata table for simple cases.
- Do not copy a live database with `cp`. In WAL mode you will miss the WAL; in rollback mode you
  can catch a half-written commit. Use `VACUUM INTO` or the backup API, covered in chapter 7.

## Common mistakes

- Treating the `.db` file as the whole database while a `-wal` file exists next to it.
- Assuming `DELETE` or `DROP TABLE` returns disk space to the filesystem — only `VACUUM` does.
- Picking `WITHOUT ROWID` for a table with wide rows or an `INTEGER` primary key, where the
  rowid table is both smaller and faster.
- Editing a SQLite file by hand to fix one row. The b-tree invariants are not advisory.
