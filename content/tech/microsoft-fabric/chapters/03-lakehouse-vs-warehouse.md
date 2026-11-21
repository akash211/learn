# Lakehouse vs Warehouse

This is the most-asked Fabric design question, and most weak answers describe marketing rather
than mechanics. Both items store Delta tables in OneLake. Both expose a SQL analytics endpoint.
Both sit on the same distributed SQL engine. The differences are the **write path**, the
**development surface**, and the **transaction guarantees** — and those differences decide
which one owns your gold layer.

## What each item actually is

A **lakehouse** is a Spark-first container with `Tables/` and `Files/`. You write with
notebooks, Spark job definitions, pipelines, dataflows or shortcuts. Fabric automatically
generates a **SQL analytics endpoint** over the Delta tables, which is read-only T-SQL: `SELECT`,
views, table-valued functions, and stored procedures, but no `INSERT`, `UPDATE`, `DELETE`,
`MERGE` or `CREATE TABLE`.

A **warehouse** is a T-SQL-first relational store with full DDL and DML — `CREATE TABLE`,
`COPY INTO`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, stored procedures — plus
multi-table ACID transactions. Its tables are Delta in OneLake, but only the warehouse engine
writes them; Spark reads them, it does not own them.

| Dimension | Lakehouse | Warehouse |
|---|---|---|
| Primary language | PySpark, Spark SQL, Scala, R | T-SQL |
| Data types | Structured, semi-structured, unstructured | Structured, relational |
| Multi-table transactions | No | Yes |
| Write path | Spark / pipelines / dataflows | T-SQL DML, `COPY INTO`, pipelines |
| SQL surface | Read-only endpoint (DQL, views, TVFs) | Full DQL, DML and DDL |
| Cross-database queries | Via shortcuts and the SQL endpoint | Three-part names across warehouses and lakehouses |
| Best fit | Engineering, data science, medallion bronze/silver, gold for Direct Lake | Dimensional marts, SQL-first teams, procedures and heavy DML |

## The SQL analytics endpoint is not a warehouse

It is a system-generated, read-only surface that shares the warehouse engine, and it inherits
its limitations. Things worth knowing before you promise an analyst "SQL access to the lake":

- Only Delta tables in `Tables/` are visible. Tables written to `Files/`, or external Delta
  tables created by Spark outside the managed folder, do not appear. The workaround is a
  shortcut in `Tables/`.
- Delta column mapping by name works; mapping by ID does not (name mapping itself has been in
  preview at times — check the current status).
- Types are projected into the warehouse type system, so a few Spark types arrive narrowed or
  renamed.
- Adding a foreign key constraint can block later schema changes on that table.
- SQL granular permissions, RLS and column-level security set on the endpoint apply **only**
  through the endpoint. The same user reading the same table through Spark is governed by
  workspace roles and OneLake permissions instead.

That last point causes real incidents: a team locks down a table in SQL, then discovers Spark
serves it happily to anyone with workspace read access.

## Choosing, without religion

Use the warehouse when the work is relational and set-based: conformed dimensions, `MERGE`
upserts across several tables in one transaction, stored procedures that other tools call,
heavy `UPDATE`/`DELETE`, or a team that lives in SSMS and T-SQL. It is also the better home for
a gold star schema consumed by Direct Lake on SQL, because SQL views and SQL-based security
have defined behaviour there.

Use the lakehouse when the work is engineering: heterogeneous files, semi-structured JSON,
large-scale transformations, ML feature preparation, Bronze landing, or anything where Spark's
parallelism is the point. It is the natural home for bronze and silver in a medallion design.

A pattern that works well in practice:

1. **Bronze** — lakehouse, raw landing, shortcuts or Copy jobs, append-only, minimal typing.
2. **Silver** — lakehouse, Spark cleansed and conformed Delta tables, compacted and partitioned.
3. **Gold** — either a warehouse star schema built in T-SQL, or a curated lakehouse schema read
   by Direct Lake. Pick one per domain; running both is how you get two versions of the truth.

## Common mistakes

- Using the warehouse for Spark-heavy transformation because "it's a warehouse" — you lose
  Spark and gain nothing.
- Promising write access through a lakehouse SQL endpoint. It is read-only, full stop.
- Duplicating every table into both items "for safety", then reconciling them forever.
- Assuming the SQL endpoint sees every Delta table in the lake; it only sees `Tables/`.
- Forgetting that a lakehouse no longer gets an auto-created default semantic model (Microsoft
  stopped creating them in September 2025 and decoupled existing ones by the end of November
  2025). Reports now point at an explicit semantic model you own.

## Production notes

Both items share the capacity, so the choice is not a cost isolation strategy. Keep one owner
per gold table, document whether it is written by Spark or T-SQL, and put the SQL endpoint's
security model in writing for analysts. If you need cross-database joins, three-part naming
(`warehouse.schema.table`) works across warehouses and lakehouses in the same workspace without
copying data — a good reason to co-locate related items rather than scattering them across
workspaces.
