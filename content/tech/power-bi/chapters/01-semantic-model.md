# The Semantic Model

A Power BI semantic model is the analytical contract between data and reports. It contains tables, columns, relationships, measures, hierarchies, formatting, descriptions and security rules. A well-designed model makes common questions natural to ask and hard to misinterpret. A report should not need to reconstruct business meaning independently in every visual.

## Start with grain and a star schema

Before importing columns, state what one row represents in every fact table. A sales fact might have one row per order line; an inventory snapshot might have one row per product, warehouse and day. Grain determines which aggregations are valid. If a report sums a daily snapshot across days as though it were a transaction, the resulting inventory is meaningless even if the visual renders successfully.

A star schema separates measurable events from descriptive context. Fact tables contain foreign keys to dimensions and numeric facts such as quantity or net amount. Dimensions contain attributes used to filter, group and label: date, customer, product, geography or channel. Dimension keys should identify one row per entity. In a classic star, dimensions filter facts through one-to-many relationships. This is usually easier to reason about and more efficient than a single flattened table or a network of bidirectional relationships.

Dimensions can be conformed across facts. A shared Date dimension allows sales and returns to be compared at the same calendar grain, while the two facts remain separate. Use a role-playing date dimension or inactive relationships when a fact has several date roles, such as order date and ship date. Avoid joining fact tables directly merely because they share a business key; doing so can multiply rows and produce ambiguous totals. Model each business process at a deliberate grain.

## Relationships: cardinality and direction

Cardinality describes the uniqueness pattern at each end: one-to-many, many-to-one, one-to-one or many-to-many. For a dimension-to-fact relationship, the dimension key should be unique on the one side and may repeat on the fact side. Duplicates in the dimension are often a data-quality or key-design issue, not a reason to casually select many-to-many. Relationships also have active/inactive status and a cross-filter direction.

Single-direction filtering from a dimension to a fact is the default for most star schemas. It gives a predictable path: selecting a product filters sales, while sales rows do not unexpectedly filter the product list or other dimensions. Bidirectional filtering can be appropriate for particular designs, but can create ambiguity, unexpected slicer behavior and slower queries. Use it only when the propagation is understood and tested. For a specific measure, DAX functions such as `CROSSFILTER` can change relationship behavior locally instead of making the entire model bidirectional.

Many-to-many relationships require explicit business meaning. A bridge table can represent a customer belonging to multiple segments or a person assigned to multiple projects. Decide whether totals should count a fact once, once per membership, or be allocated by a weight. A relationship alone cannot choose the desired accounting rule. Document allocation logic and test totals against known examples.

## Measures, calculated columns and metadata

A measure is evaluated when queried, under the current filter context. For example:

```DAX
Net Sales :=
SUMX ( Sales, Sales[Quantity] * Sales[Net Unit Price] )
```

If the source already supplies a validated line amount, a simple `SUM(Sales[Net Amount])` is typically clearer and cheaper. A calculated column is materialized for each row during model processing and stored in the model; it can support grouping or relationships but increases model size. A measure is generally the right choice for aggregations that need to respond to slicers.

Hide technical keys and staging columns from report view, set data types and formats accurately, and provide business-friendly names and descriptions. Use a dedicated Date table with a continuous date column, mark it as a date table when appropriate, and define fiscal attributes explicitly. A measure named `Gross Margin %` should have a format and a definition that makes its denominator clear. Display folders and perspectives can help larger models without changing calculation semantics.

## Grain, slowly changing attributes and bridges

Grain also controls how dimensions evolve. If a customer's territory changes, decide whether historical sales should be reported under the territory at the time of sale or under the customer's current territory. A Type 1 overwrite answers the current-state question; a Type 2 dimension preserves versions with effective dates and a surrogate key so facts can point to the historically valid row. This is an upstream data-modeling decision that the Power BI relationship must respect. Simply relating every historical fact to a current customer row can rewrite history unintentionally.

Bridges are useful when membership is genuinely many-to-many, but their path needs explicit tests. If a sale is associated with two campaign tags, filtering by either tag may be useful while summing revenue across both tags can double-count the transaction. A bridge relationship does not imply allocation. If the business needs attributed revenue, store allocation weights that sum to one per transaction or define another approved rule. Test totals with no bridge filter, one selected member and multiple selected members. Explain any non-additive result in the measure description.

## Validate the model, not just the diagram

A diagram can look star-shaped while the logic remains wrong. Test totals at multiple grains: overall, by month, by product and by customer. Check referential integrity, unknown keys, duplicate dimension keys and blank members. Compare model outputs with a trusted source query or reconciled report. Test slicer combinations, inactive date roles, and dimensions that do not apply to every fact. Use explicit measures rather than relying on implicit sums for important KPIs.

### Common mistakes

A final model review should also inspect sort-by columns, hidden fields and default summarization. A month label such as “Jan” needs a numeric month sort key; otherwise visuals sort alphabetically and tell a false time story. Mark columns as “Do not summarize” when adding them by default would be nonsensical, but still encourage explicit measures for important metrics. Check blank dimension members and decide whether they represent unknown, not applicable or missing source data. Those states can have different business meanings. A visible “Unknown” member is often safer than silently dropping unmatched fact rows, but the source quality issue should still be measured and assigned to an owner. Review measure names and formats with report consumers so a decimal ratio is not presented as a currency or an unqualified percentage.

- Treating relationship cardinality as a setting to silence duplicate-key warnings rather than investigating grain and keys.
- Using bidirectional filtering everywhere to make slicers appear connected.
- Mixing transaction facts and periodic snapshots without defining valid aggregation behavior.
- Flattening every attribute into a fact and then repeating calculations across reports.
- Assuming a Date table or relationship automatically defines fiscal, week or business-calendar rules.

### Production notes

A model is a versioned product. Establish who owns its measures, how breaking changes are communicated, and which reports depend on it. Make transformations that are shared and stable upstream when possible. Keep the semantic model focused on analytical behavior, expose only useful columns, and document exceptional relationships. Performance and correctness both improve when the model reflects business processes rather than mirroring source-system tables blindly.
