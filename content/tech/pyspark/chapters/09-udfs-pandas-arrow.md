# UDFs, Pandas UDFs and Serialisation Cost

A Python UDF is the main place in a PySpark job where Python touches individual rows. It is also
usually the most expensive thing the job does. The cost is not Python being slow at arithmetic; it
is the round trip: every row is serialised in the JVM, written to a socket, unpickled in a worker
process, transformed, pickled again, and deserialised back.

## What a Python UDF costs

```python
from pyspark.sql import functions as F
from pyspark.sql.types import StringType

def clean_name(s):
    return s.strip().title() if s else None

clean = F.udf(clean_name, StringType())
df.select(clean("name"))
```

The plan:

```
+- BatchEvalPython [clean_name(name#7), pythonUDF0#20]
   +- FileScan parquet [name#7]
```

Three separate costs appear at once:

1. **Serialisation per row.** Pickle, socket write, JVM read, per row. On million-row inputs this
   dominates everything else.
2. **Codegen stops.** `BatchEvalPython` is a separate operator; whole-stage codegen is split
   around it, and the pipeline loses its fused loop.
3. **Optimisation stops.** Catalyst cannot see inside the function, so it cannot push a filter
   below it, fold constants, or prove the function deterministic. A `filter` that would have been
   pushed into the Parquet scan now runs after the UDF has processed every row.

`df.select(clean("name")).filter(...)` reads and converts every row before filtering. The
equivalent built-in `F.trim` / `F.initcap` reads only the rows the filter keeps.

## The preference ladder

Before writing a UDF, walk down this list:

| Option | Speed | When |
|---|---|---|
| `pyspark.sql.functions` built-in | fastest — JVM, codegen'd | almost always; the library is larger than people think |
| SQL expression | same as built-in | string manipulation, dates, JSON paths, higher-order functions |
| `pandas_udf` (Arrow, vectorised) | fast: batch transfer, numpy inside | numeric/string transforms over columns |
| `applyInPandas` / `mapInPandas` | medium: batch transfer, Python loop inside | per-group models, custom batch logic |
| Python `udf` | slow: row-by-row pickle | genuinely custom scalar logic, last resort |
| `rdd.map` | slow and unoptimised | non-tabular work |

The built-in library covers more than it seems: `regexp_replace`, `split`, `array_sort`,
`transform`, `filter` (on arrays), `aggregate`, `from_json`, `to_json`, `date_trunc`,
`percentile_approx`, `sha2`, `xxhash64`, `levenshtein`, `soundex`. Higher-order functions
(`transform`, `filter`, `aggregate`, `exists`) let you express array logic without dropping into
Python at all.

## pandas UDFs

A pandas UDF transfers data in Arrow batches instead of pickled rows, and the function receives a
`pandas.Series` or `DataFrame` rather than a scalar:

```python
import pandas as pd
from pyspark.sql.functions import pandas_udf

@pandas_udf("double")
def zscore(s: pd.Series) -> pd.Series:
    return (s - s.mean()) / s.std()

df.withColumn("z", zscore("amount"))
```

Inside the function, use numpy or vectorised pandas, never `.apply`. A pandas UDF that loops over
rows is slower than a plain Python UDF, because it pays Arrow conversion *and* Python per-row
overhead.

Three details that bite:

- **Batch size.** `spark.sql.execution.arrow.maxRecordsPerBatch` (default 10000) controls how many
  rows arrive per batch. Large batches mean fewer calls and more memory per task; with wide rows,
  10,000 can be hundreds of megabytes.
- **Null handling.** pandas represents nulls as `NaN`/`NaT`; integer columns with nulls become
  floats unless you use pandas nullable dtypes. A UDF that returns `int` from a column with nulls
  will produce wrong values or fail.
- **Output length.** A scalar pandas UDF must return a Series of the same length. Returning a
  different length raises at runtime, not at definition.

`pandas_udf` always uses Arrow to move data, regardless of
`spark.sql.execution.arrow.pyspark.enabled`. That config governs `toPandas()`,
`createDataFrame(pandas_df)` and `collect()` conversions — it is false by default in open-source
Spark 3.5 and true in Databricks Runtime, which is why the same notebook can behave differently
on the two platforms.

## Grouped and iterator APIs

| API | Signature | Use |
|---|---|---|
| `pandas_udf(..., functionType=SCALAR)` | `Series -> Series` | elementwise vectorised |
| `pandas_udf(..., functionType=GROUPED_AGG)` | `Series -> scalar` | custom aggregation per group |
| `df.groupBy(k).applyInPandas(f, schema)` | `DataFrame -> DataFrame` | one model per group, arbitrary output schema |
| `df.mapInPandas(f, schema)` | `Iterator[DataFrame] -> Iterator[DataFrame]` | batch processing with bounded memory |
| `df.mapInArrow(f, schema)` | `Iterator[RecordBatch] -> Iterator[RecordBatch]` | Arrow-native, avoids pandas overhead (3.3+) |
| `df.groupBy(k).applyInArrow(f, schema)` | `RecordBatch -> RecordBatch` | grouped, Arrow-native (3.5+) |

`applyInPandas` is the standard way to fit a model per customer or per store:

```python
schema = "store_id long, forecast double"

def forecast(pdf: pd.DataFrame) -> pd.DataFrame:
    model = fit(pdf)                       # your code
    return pd.DataFrame({"store_id": [pdf.store_id.iloc[0]],
                         "forecast": [model.predict_next()]})

result = sales.groupBy("store_id").applyInPandas(forecast, schema)
```

The constraint is that **one group must fit in one worker's memory**. A skewed key with 40 million
rows will OOM the executor's Python worker, not fail gracefully. Check the group-size distribution
first, and split or salt hot keys before using `applyInPandas`.

`mapInPandas` and `mapInArrow` take an iterator, so you can process batches incrementally and keep
memory flat — the right choice for streaming a large table through Python logic.

## Arrow-optimized Python UDFs

Spark 3.5 added `spark.sql.execution.pythonUDF.arrow.enabled` (default false). It keeps the
familiar row-at-a-time Python function but transfers data through Arrow batches instead of
pickling each row, removing most of the serialisation cost.

It is a serialisation optimisation, not a vectorisation one: the function is still called once per
row, so numpy-style speedups do not apply. If the logic can be expressed vectorised, a `pandas_udf`
is still faster; if it must be row-at-a-time (complex branching, third-party library), Arrow
transfer is a straight win.

## Java and Scala UDFs

A UDF written in Java or Scala runs inside the JVM, with no serialisation boundary:

```python
spark.udf.registerJavaFunction("my_udf", "com.example.MyUDF", "double")
spark.sql("SELECT my_udf(amount) FROM t")
```

This is the escape hatch when a Python UDF is the bottleneck and the logic can be written in a JVM
language. It requires building a jar and adding it to the classpath (`--jars`), and it is a real
maintenance cost. The third option — expression logic in SQL — is usually better.

## Debugging UDFs

- Exceptions arrive wrapped: `PythonException: An exception was raised by worker code`, with a
  truncated Python traceback. The original line is usually visible; the worker's stderr is in the
  executor logs.
- Segfaults (a bad native library inside a UDF) kill the worker silently. Set
  `spark.sql.execution.pyspark.udf.faulthandler.enabled=true` to get a Python faulthandler
  traceback instead of a generic connection-reset error.
- `spark.python.worker.memory` (default 512 MB) bounds the worker's memory before it spills
  aggregation state to disk; raise it for large group-bys inside pandas UDFs.
- Test the function as plain Python first. Most UDF bugs are ordinary Python bugs that the cluster
  makes hard to see.

## Common mistakes

- Using a UDF for something `pyspark.sql.functions` already provides.
- Filtering after a UDF instead of before it, forcing the UDF to process rows that will be
  discarded.
- Returning `None` from a UDF declared with a non-nullable return type.
- `applyInPandas` on a key with millions of rows in one group.
- Forgetting that a Python UDF blocks predicate pushdown, then blaming the file format for a slow
  scan.
- Assuming `spark.sql.execution.arrow.pyspark.enabled` speeds up `pandas_udf` — it does not;
  pandas UDFs always use Arrow.

## Production notes

Measure before rewriting: the Spark UI's SQL tab shows `BatchEvalPython` with rows in and out and
the time spent. A UDF that takes 60% of a stage is worth rewriting; one that takes 2% is not.

When a UDF must stay, keep the columns it touches narrow (`select` before the UDF), keep the rows
it processes few (filter before the UDF), and prefer Arrow transfer. Those three changes usually
recover most of the gap without touching the logic.
