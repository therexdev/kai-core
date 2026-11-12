# Local model testing and Earn approval

The model library has a separate **Unsupported Earn Models** section. It uses the existing resumable download queue and local inference APIs. No plugin changes are required for a plugin that already enumerates Core's local model list. Plugins that only support network inference will not see these as network choices.

## Initial candidates

| Model | Alias | Download | Suggested memory |
| --- | --- | --- | --- |
| Gemma 4 12B | `gemma4-12b` | 7.7 GB | 16 GB+ |
| Muse-Glimmer 30B | `muse-glimmer-30b` | 16.8 GB | 32 GB+ |
| Qwen 3.8 27B | `qwen38-27b` | 17.4 GB | 32 GB+ |
| Gemma 4 31B | `gemma4-31b` | 19.6 GB | 32 GB+ |

Sizes are decimal GB rounded for display; the catalog stores exact artifact sizes. Memory guidance is not a speed guarantee. Integrated GPUs share system memory. These entries are text-only, start with an 8,192-token context, use the managed llama.cpp engine and their embedded Jinja chat templates, and disable unvalidated Ollama fallback. A zero reasoning budget prioritizes visible writing within existing output limits. They are experimental, not a claim that inference quality or performance has been verified on every supported device.

## Test locally

1. Open **Model library**, scroll to **Unsupported Earn Models**, and choose **Download & load**. Multiple choices use the existing queue; each download can be cancelled independently.
2. Choose the downloaded model in local chat or a plugin with local inference support. Local inference does not buy network credits. Local work shares the runtime with Earn and can temporarily pause network capacity while the local task runs.
3. Compare the same writing prompt against an existing model. Record coherence, instruction following, repetition, originality, startup time, speed, and errors.
4. Choose **Share feedback** to open a GitHub report template. Add Core version, operating system, RAM/GPU and results. Review it before submission; no conversation, wallet or account data is attached automatically.

Imported GGUF files also appear as local-only choices, without public feedback links that could expose private filenames. Importing a model does not approve it for Earn.

## Catalog and network boundaries

`core/models/catalog.json` is the bundled download catalog. `aliases[alias].localOnly: true` is an explicit exclusion from network work. It is exposed by `ModelManager.aliases()` for UI and SDK consumers but does not block resolving, downloading, or running the model locally.

Both `CreditProvider.models()` and the worker's registration/job admission enforce this exclusion. A matching remote tariff is insufficient while the flag remains true. Existing network policy commitments, prices, paid-job hashes and qualification requirements are unchanged. Merely installing more models or enabling share-all does not bypass them.

New entries must pin an immutable Hugging Face revision, exact SHA-256 and artifact size. These four entries were checked against the publishers' LFS metadata and bounded GGUF header requests on 2026-11-12. Full downloads are SHA-256 verified by Core's existing downloader before use. Header checks are not full-model inference tests.

## Approve a candidate for Earn

1. Verify its license and exact artifact, then test real inference with the packaged runtime on the intended provider devices. Test loading, streaming/non-streaming output, cancellation, template parsing, memory use, sustained generation and writing quality.
2. Prepare the reviewed network model tariff with exact model, tokenizer and template pins, output/context limits and pricing. Update the committed policy/catalog extension through the existing network approval process; do not turn local catalog metadata into network authority.
3. Set `localOnly` to false or remove it in the reviewed Core catalog update. Keep the alias, package ID, filename and hash if the approved artifact is identical. Existing downloads will then be reused. Changed weights require a new package identity and verification.
4. Publish the reviewed Core/network updates through their normal release process. Providers must still select/share the model, meet memory requirements and pass network qualification before it earns.

## Validation

Run `npm test`, `npm run test:services`, `npm run test:foundation-native`, and `node scripts/foundation/local-models-smoke.js`. The last check launches the real Core UI in an isolated local-only profile and validates the section, sizes, feedback confirmation and compact layout. It does not download or run the models. In environments without Unix domain sockets, the existing `KAI_SMOKE_SYNTHETIC_LOCK=1` fixture option replaces only the test profile's single-instance lock; it does not test real desktop lock behavior.

Windows signed installers and real provider hardware still require native release verification. This source change does not publish an installer or enable any new paid model.
