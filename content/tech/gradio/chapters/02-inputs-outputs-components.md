# Inputs, Outputs and Component Types

A Gradio component is both a browser control and a Python-side data contract. It describes what the user can enter or what the app can show, and it preprocesses or postprocesses values crossing the boundary. Choosing a component therefore affects usability, serialization, validation and memory—not just appearance.

## Choose by the value your function needs

Text components include `Textbox`, `Markdown`, `Chatbot`, `JSON` and `Code`. Inputs such as `Textbox` generally deliver Python strings, while display-oriented components render structured output. A textbox's `lines`, `placeholder`, `type` and `interactive` settings shape the experience; they do not replace server-side validation. For structured records, `JSON` can be more honest than asking a user to paste an undocumented string format, but validate keys, types, sizes and allowed operations in Python.

Numeric and selection controls include `Number`, `Slider`, `Checkbox`, `CheckboxGroup`, `Radio` and `Dropdown`. Use discrete choices for bounded categories and a slider only when the value is naturally continuous or ordered. A browser-provided minimum, maximum or default is helpful guidance, not a security invariant; a direct client can send unexpected data. Validate again in the callback before expensive work or side effects.

Tabular and visualization components include `Dataframe`, `Dataset`, `Plot`, `ScatterPlot`, `LinePlot`, `BarPlot`, `Gallery` and `Label`. Their accepted Python values vary: a table might be represented with pandas, NumPy or list-like data depending on configuration and version; plots commonly use a supported plotting object or data representation. Consult the component documentation for the exact contract and test the installed version. Avoid implicitly converting enormous frames to browser payloads: render a useful sample or summary when the full data is large.

## Inputs and outputs can share a component family, not a contract

Many components can be used in input, output or both directions, but the Python types may differ. `gr.Image` can receive an uploaded image and provide a PIL image, NumPy array or filepath depending on its `type` setting; as output it can display supported image values or a path managed by Gradio. Make the choice explicit where reproducibility matters. A filepath is not automatically a durable identifier, and a temporary file can disappear after its lifecycle ends.

Build a small probe callback during development to inspect actual values and types. This is safer than relying on recollection, particularly across Gradio releases. Document conversion behavior at the boundary: for example, normalize an uploaded image to RGB and expected dimensions before inference, and return a clear user-facing error if decoding fails. Keep model code accepting an ordinary Python representation rather than a Gradio component object.

## Components are adaptable, but limits remain application-specific

A component's `label`, `info`, visibility, interactivity and choices can be configured to guide the user. Some event callbacks return updated component properties, which can enable dependent dropdowns or progressive forms. This is a UI behavior, not a data schema. Validate selected values against authoritative server-side options, especially when they influence file paths, queries, model selection or administrative actions.

`gr.State` is a special component for server-side session state rather than a visible input. It should not be confused with a persistent database. State values should be copyable and suitable for in-memory session handling; keep bulky model weights, open file handles and unbounded histories outside it. The state chapter covers its lifecycle and concurrency implications.

Custom components are an option when built-ins do not represent the interaction, but add frontend build, compatibility and maintenance costs. First see whether `HTML`, `Markdown`, a built-in chart or a Blocks arrangement is sufficient. Avoid injecting untrusted HTML or JavaScript: escaping and content-security decisions belong in a deliberate security design.

## A practical mapping table

| User task | Typical component | Boundary questions |
|---|---|---|
| Enter a prompt or note | `Textbox` | Is empty text allowed? What length and normalization apply? |
| Upload a photo | `Image` | PIL, NumPy or filepath? What formats, dimensions and orientation? |
| Send a media file | `File` or specialized media component | Is the callback receiving bytes, path or metadata? Who cleans up? |
| Choose one option | `Radio` or `Dropdown` | Are values stable identifiers or display labels? Are they validated server-side? |
| Inspect a result table | `Dataframe` | How much data is sent to the browser? What types and index semantics? |
| See ranked predictions | `Label` | Are confidence scores calibrated and explained? |
| Inspect generated media | `Audio`, `Video`, `Gallery` | What format and path lifecycle apply? Can output be streamed? |

The best component reduces translation work for users without creating an opaque type conversion for the application. Prefer a clear Python contract over matching a component to a fashionable visual pattern.

## Component defaults and examples

Defaults should be safe and useful. If an app uses a particular model or mode, set it explicitly rather than relying on a default that can change between versions. Examples can teach input formatting and make a demo immediately usable, but they are part of the exposed product: do not use copyrighted, personal or confidential examples without permission. For internal apps, examples may also leak what the team considers typical data.

Validation should be layered. Component configuration provides early feedback, callback validation rejects invalid values, and domain logic enforces business rules. For an integer count, verify integral type and a sensible application range. For a file, verify actual content rather than trusting its name or browser MIME type. For an enum, match a known identifier. Return errors that help the user correct input without disclosing secrets or internal stack traces.

## Common mistakes

- Assuming `Image` always returns a PIL object; the configured type controls preprocessing behavior.
- Treating a slider's bounds, dropdown choices or hidden component as server-side authorization.
- Sending large tables, arrays or image batches to the browser without considering serialization and memory.
- Returning a filesystem path that is outside Gradio's permitted/served file handling or that will not exist later.
- Depending on a component's implicit defaults across upgrades instead of setting and testing the intended behavior.

## Production notes

Write small tests around input normalization and output conversion. When upgrading Gradio, exercise representative values for files, images, audio, tables and generators, because boundary behavior is where framework and application assumptions meet. Keep media processing limits in your own service policy: accepted formats and safe sizes depend on the deployment and threat model, not on a universal Gradio limit.

When a component update changes its available choices, keep a canonical list on the server and validate the selected value again in the callback. A user can submit a value not shown in the current dropdown. Likewise, update dependent fields only after checking the parent selection. This avoids stale UI state becoming an invalid model argument and helps ensure UI convenience does not silently become policy.
