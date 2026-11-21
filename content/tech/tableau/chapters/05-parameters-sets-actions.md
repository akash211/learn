# Parameters, Sets, and Actions

## Parameters: values chosen by the user

A parameter is a workbook variable with a defined data type and current value. It can hold a number, string, date, or another supported type and can be exposed as a control. A parameter alone does not filter data or change a chart: a calculation, reference line, filter, or other feature must use its value. This is the essential difference between a parameter and a filter. A filter selects data members; a parameter stores a value that logic can consult.

A common pattern is a measure selector. Create a string parameter with choices such as Sales, Profit, and Quantity, then a calculated field returns the selected measure. A second pattern is a threshold parameter used in a calculated condition. A date parameter can set a comparison period or anchor a calculation. Parameters can be used in calculations, bins, reference lines, and supported connection or dashboard behaviors, but exact use depends on the Tableau feature and connector. Avoid promising that changing a parameter dynamically rewrites any arbitrary SQL in a secure or portable fashion.

A parameter's allowable values may be a fixed list, a range, or all values, depending on its type and configuration. Dynamic parameter behavior can refresh values from a field when a workbook opens or under supported conditions; it does not mean every control updates continuously for all users. Ensure the default is valid and communicate its effect. A parameter action can update a parameter based on a user's selection in a source view, enabling custom interactions such as choosing a metric or reference point.

## Sets: explicit membership

A set represents membership in a subset of dimension values. A set can be fixed (manually chosen), condition-based, or top-based; dynamic set membership updates as underlying data and criteria change. A set has IN and OUT membership, which can be used in calculations, filters, colors, or labels. For example, a set of selected customers can distinguish members from the rest, or a top customers set can compare leading customers against all others.

Sets differ from groups. A group combines selected dimension members into named categories; a set asks whether a member belongs to a defined subset. Sets also differ from parameters: a parameter is generally one value, while a set can contain multiple dimension members. A parameter can drive a set or a calculation through supported patterns, but the objects have distinct semantics.

A set control can let users choose members in supported authoring and publishing contexts. Set actions can change set membership based on marks selected in another view. Before using a set action, decide whether selection should replace, add to, or remove from membership and how clearing the selection behaves. If the set is used in a calculation, test both IN and OUT states and the empty-selection case.

## Actions: connect views and controls

Dashboard actions create interaction between worksheets or between a view and another target. Filter actions pass selected field values to a target sheet. Highlight actions emphasize related marks without necessarily filtering them out. URL actions navigate to a link, and parameter and set actions update those objects. A worksheet can also have a navigation or change-parameter behavior depending on version and setup. Actions make a dashboard feel responsive, but each one introduces a state transition that must be understandable.

A filter action should specify source sheets, target sheets, fields to pass, and what happens when the selection is cleared. “Show all values” can be appropriate when clearing a selection; “exclude all values” can be useful in a focused drill-through, but can confuse a user who accidentally clears. Use a visible instruction or a clear reset control. Test selections on marks with null, duplicate, or unmatched keys. Actions based on fields with different names may require explicit field mapping.

Highlighting preserves context by leaving other marks visible but muted. Filtering reduces the target's displayed data. These are not interchangeable. For comparisons, highlight can preserve a baseline; for detail views, filtering can reduce clutter. Avoid using a click interaction as the only way to reveal critical information if keyboard or touch users cannot discover it.

## Designing coherent interaction

Map each interaction to a user question. A Region selector answers “which regions should I compare?” A parameter-driven metric switch answers “which measure should I view?” A set action answers “which members should form the selected cohort?” A filter action answers “what details correspond to this selection?” If two controls appear to do the same thing, simplify. Use concise names and labels so a consumer can distinguish a filter from a parameter or a set control.

Interaction state can affect more than one dashboard sheet. Make scope explicit and avoid hidden coupling where one selection unexpectedly changes a summary, a denominator, or a title. For parameter-driven calculations, use dynamic titles or subtitles to show the active metric, date anchor, or threshold. For sets, label membership and the population used for comparison. For filter actions, show a clear reset path and explain what is currently selected.

Parameters can be used to expose a chosen threshold without requiring users to edit a filter, but a numeric parameter does not enforce a security policy. Similarly, a set that identifies restricted users is not a robust row-level security implementation by itself. Trust boundaries belong in the data source, database, or platform authorization model.

## A practical example

Imagine a performance dashboard with region sales and a product detail sheet. A Region filter defines the high-level slice. A parameter called “Metric” switches the bar chart between Sales and Profit using a calculated field. A Top Products set highlights the leading products. Selecting a region can invoke a filter action to update product details, while selecting a product might invoke a parameter action to update a comparison target. Each action should have one clear purpose, and the dashboard should state the active metric and selected region.

Build the interaction in steps and test representative states: no selection, one selection, multiple selections, a cleared selection, and a selection with no matching target. Confirm that totals and denominators behave as intended. A set membership or parameter update can change a calculation even if the sheet's visible marks appear unchanged, so inspect both display and results.

## Common mistakes

- Expecting a parameter to filter data without a calculation or feature that consumes it.
- Calling a set a filter or a group and ignoring its IN/OUT membership model.
- Creating a filter action without defining what clearing a selection does.
- Using a parameter or set to enforce access restrictions.
- Failing to label the active parameter choice in a dynamic chart.
- Adding interaction for novelty without a clear question or reset path.

## Production notes

Keep action names, control labels, and calculation names meaningful. Test dashboards with mouse, keyboard, and touch assumptions relevant to the audience. Make the initial state useful, the active state visible, and recovery from an accidental selection obvious. Treat parameters, sets, and actions as part of the user interface and analytics contract, not as decoration.
