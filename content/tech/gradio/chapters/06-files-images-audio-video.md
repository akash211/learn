# Files, Images, Audio and Video

File and media components make a Gradio demo useful for real model workflows, but they cross several boundaries at once: browser upload, temporary storage, Python preprocessing, model inference, output serialization and browser playback. Treat every uploaded file as untrusted input and every temporary path as short-lived unless your app deliberately persists it.

## File component and upload lifecycle

`gr.File` is the generic choice for documents and arbitrary supported file workflows. A component can be configured for input or output and, depending on its settings and Gradio version, can deliver a path-like value or file data. Be explicit about the desired `type` and `file_count`, and test actual callback values with the installed version. Do not assume that an uploaded file is a Python `bytes` object or that its original filename is safe to use as a path.

An upload may be copied to a Gradio-managed temporary location. The path is useful for libraries that accept paths, but it can be removed as part of cleanup and is not a permanent download URL. If an output must remain accessible, save it to a controlled durable location and return it through an approved file-serving flow or a signed URL with authorization and expiry. Avoid writing user files to a predictable shared directory where names can collide or be guessed.

Validate content, not just extension. Check expected format and parse it with a library that handles malformed input safely. Consider maximum accepted size, decompression expansion, archive traversal, parser vulnerabilities and time spent decoding. These limits are application policy and deployment choices; there is no single universal safe size. Reject unexpected files before loading them into memory or passing them to a heavyweight model.

## Image data and preprocessing

`gr.Image` is a specialized component with a `type` option that controls the callback representation, commonly PIL image, NumPy array or filepath. Its mode and preprocessing options also affect dimensions and channels. Choose one representation and convert at a clear boundary. Normalize color mode, orientation, dimensions and dtype according to the model's input contract; do not rely on a browser preview as proof that inference received the expected pixels.

For image-to-image workflows, return an image in a supported representation and keep transformations deterministic where possible. Large images and image batches can consume far more memory than the compressed upload suggests. Decode dimensions first where feasible, cap pixels according to the application's needs, and avoid retaining both source, full-resolution intermediate and output in per-session state. Use thumbnails for galleries and operator review when full resolution is unnecessary.

When returning an image file, make its lifecycle clear. A generated file kept in a temporary directory may be served by Gradio only during the app's serving lifecycle and subject to file-access configuration. Test downloads through the real deployment path rather than only displaying an in-memory PIL object in a local session.

## Audio and video

`gr.Audio` supports microphone or file workflows, and its callback input/output shape depends on configuration. Common Python representations include a sample rate paired with a NumPy array or a filepath. Inspect and test the exact configured behavior. Audio pipelines need explicit sample-rate, channel, duration and encoding assumptions; model frontends often resample or normalize internally, but that should be a deliberate step. A filename ending in a common extension does not ensure valid or safe encoded audio.

`gr.Video` handles video inputs and outputs using a file-based media workflow. Video decoding is computationally expensive and container/codecs vary by environment. Establish a supported format policy and consider duration, resolution, frame rate and audio track handling. For inference, sample frames intentionally instead of decoding an entire video into a huge in-memory tensor. Make it clear whether output is a playable video, a frame montage or a downloadable artifact.

Specialized components can support streaming input or output patterns in recent Gradio releases, but streaming media has different requirements from a completed file: chunk framing, buffering, browser codec support and cleanup all matter. Confirm the current component guide and test across target browsers. Do not equate yielding an array from Python with a standards-compliant live media stream.

## Secure file processing

The browser's filename, MIME type and declared size are user-controlled. Use generated names and a private workspace; never construct a path by concatenating an upload name with a trusted directory. Parse the file using a maintained library and isolate risky converters if the threat model warrants it. Avoid accepting archives or office documents unless required, because these bring additional parsing and path-extraction risks.

A path received by a callback is not an authorization token. Ensure that users can only read or download artifacts they are permitted to access. Gradio's file-serving behavior is part of the app's exposure; configure allowed paths deliberately and avoid making a broad home directory or model checkpoint directory available. Remove temporary artifacts when no longer needed, with cleanup that is safe under concurrent users.

## Output conventions and multiple files

A callback may return a path or structured values according to the component type. When returning multiple files, use the output format documented for the chosen component and version. Generate unique output names and keep paths separated between users. If an output needs labels, metadata or provenance, present those as separate outputs rather than encoding them in a filename.

For long transformations, write incremental results to a managed temporary file and report progress if users benefit. Ensure partial files are removed on failure. Avoid holding entire audio/video content as a Python bytes object for extended periods unless the file is small and bounded. Streaming generator callbacks may reduce perceived latency, but the browser and component must support the particular format and update pattern.

## Common mistakes

- Trusting an extension or browser-provided content type as proof of file format.
- Persisting or sharing Gradio's temporary path as if it were a durable artifact identifier.
- Using an uploaded filename directly in a filesystem path.
- Assuming the image callback always produces PIL, or audio always produces one specific tuple shape.
- Loading long, high-resolution video completely into memory for frame-based inference.

## Production notes

Test with corrupted, oversized and unusual-format inputs, plus concurrent uploads. Measure decode time and memory, not only model execution. Set size/duration/format policy according to the application and infrastructure, and ensure user-facing errors do not reveal parser tracebacks or server paths. Treat temporary file cleanup, allowed file serving and durable artifact access as explicit parts of the design.

## Privacy and retention

Media often contains more personal information than text: faces, voices, location metadata, document scans and incidental people in a recording. Decide whether uploads are retained after processing, who can review them, and how deletion works. Remove metadata that the model does not need, and avoid saving source media in application logs or shared caches. If a workflow stores derived embeddings or transcripts, those may remain sensitive even after deleting the original file.

Explain the retention behavior in the interface where it affects user decisions. For internal review, set a retention window and ensure cleanup covers both temporary files and durable object storage. When debugging, prefer synthetic test samples. If human reviewers need access, scope it to assigned work and audit access through the application layer rather than exposing a directory listing.
