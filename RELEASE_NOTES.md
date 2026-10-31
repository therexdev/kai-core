# KAI Core Beta 0.7.9

Local model requests now run in order across chat, Documents, Compare Models and other plugins. Stopping a request also cancels it while it is queued, loading a model or waiting for response headers. Interrupted streams release their model reservation, and stopping one plugin's request does not cancel another plugin's work.

Model preparation now shows whether it is waiting, downloading an engine, extracting, verifying or starting the model. Cancel works throughout preparation. Interrupted engine setup stays staged until complete, and a completed model download can finish verification without repeatedly trying to resume past the end of the file.

Core opens without automatically loading the sole installed model. Models load when requested. Large plugin package verification, extraction and reviewed copying run off the main app thread, with bounded worker use; signatures, exact approved contents and installed code are still verified before activation.

Update Assistant to 0.3.3, Documents to 0.3.1 and Compare Models to 0.3.1 in Plugins for their matching stream fixes and interface improvements. Existing profiles, wallets, models and plugin data remain in place.

Windows Setup updates retain the established Michael Milas publisher signature and require your action to download and restart. Release checks cover Windows, macOS and Linux, native desktop behavior, cross-plugin inference ownership, and real LFM3/Qwen CPU inference. They do not reproduce every GPU or the reported machine's exact crash.
