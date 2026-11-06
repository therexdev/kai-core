# Local model context windows

Core uses each model's native context as the ceiling for automatic allocation. Input and output share the window. Short tasks start at 4K (or the model's smaller limit). Longer tasks allocate the next power of two that fits their estimated prompt and output allowance, bounded by the model ceiling and any advanced user cap. A sufficiently large loaded window can serve subsequent smaller tasks.

| Catalog model | Supported ceiling | Primary configuration or model card |
| --- | ---: | --- |
| Qwen 2.5 1.5B | 32,768 | [Qwen configuration](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct/blob/main/config.json) |
| Qwen 2.5 7B | 32,768 | [Qwen configuration](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/main/config.json) |
| Qwen 2.5 14B | 32,768 | [Qwen configuration](https://huggingface.co/Qwen/Qwen2.5-14B-Instruct/blob/main/config.json) |
| Qwen 2.5 32B | 32,768 | [Qwen configuration](https://huggingface.co/Qwen/Qwen2.5-32B-Instruct/blob/main/config.json) |
| Qwen 2.5 Coder 7B | 32,768 | [Qwen configuration](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/blob/main/config.json) |
| Qwen 2.5 Coder 32B | 32,768 | [Qwen configuration](https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct/blob/main/config.json) |
| Mistral 7B Instruct v0.3 | 32,768 | [Mistral configuration](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3/blob/main/config.json) |
| Mistral Small 24B Instruct 2501 | 32,768 | [Mistral configuration](https://huggingface.co/mistralai/Mistral-Small-24B-Instruct-2501/blob/main/config.json) |
| Phi-4 | 16,384 | [Microsoft configuration](https://huggingface.co/microsoft/phi-4/blob/main/config.json) |
| Llama 3.2 3B | 131,072 | [Meta model card](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/MODEL_CARD.md) |
| Llama 3.1 8B | 131,072 | [Meta model card](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/MODEL_CARD.md) |
| Gemma 3 4B, 12B, 27B | 131,072 | [Google model card](https://ai.google.dev/gemma/docs/core/model_card_3) |
| DeepSeek R1 Distill Qwen 32B | 131,072 | [DeepSeek configuration](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-32B/blob/main/config.json) |
| Liquid LFM3 1.7B | 262,144 | [Liquid AI model card](https://huggingface.co/LiquidAI/LFM3-1.7B) |
| Dev Tiny (SmolLM2 135M) | 8,192 | [Hugging Face configuration](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/blob/main/config.json) |

Sources checked November 4, 2026. Qwen's advertised 128K extension requires additional YaRN configuration; Core deliberately uses the ordinary 32K configuration and does not claim that extension. The catalog Llama 3.2 GGUF is a conversion of the original model, not Meta's separate 8K QAT release.

## Automatic allocation and optional caps

Core Chat and plugins can send ordinary inference requests without configuring context. Core estimates the prompt and reserves the larger of 512 tokens or the requested `max_tokens`. It prepares enough context for that task and verifies the engine's actual allocation. The estimate is approximate, especially for images and different tokenizers, so the engine remains the authority on exact token counts. A model that cannot load or verify sufficient capacity returns an error with no partial completion. Plugins can shorten or summarize their own history and retry.

The collapsed **Automatic context** control offers an optional upper limit. A saved limit applies across local requests, while each plugin's `context_tokens` request applies only to that call. **Automatic** restores the model ceiling. Changing the limit waits for active requests and preparation to finish. Catalog models retain a 4K floor for provider work. Existing minimum-RAM hints describe weights, and full-context memory requirements depend on the model and hardware.

New imports read at most the first 1 MiB of GGUF v2/v3 metadata, looking for `general.architecture` and its matching `*.context_length`. Existing imports are inspected once during startup. Unknown metadata keeps a conservative 4K ceiling for a new import. An informed owner can choose a higher ceiling up to Core's 256K administrative maximum. Package identity preserves saved caps through alias changes.

## Public plugin API

```js
// Automatic context for this task.
const answer = await api.models.chat({
  model: "koinos-smart",
  messages: [{ role: "user", content: "Summarize this document…" }],
  max_tokens: 1024,
});

// An optional minimum for a task with a specific context requirement.
const larger = await api.models.chat({
  model: "koinos-smart",
  messages,
  max_tokens: 2048,
  context_tokens: 32768,
});
console.log(larger.kai_context); // { contextSize: 32768, verified: true }
```

`context_tokens` is a positive integer denoting minimum total input plus output capacity for one request. Core also reserves enough for the estimated prompt and requested output when these exceed that minimum. Requests above the model/user ceiling fail before model preparation. Allocations are queued and shared safely, with active generations retaining their model until they finish. Preparing a model alone uses the small baseline. A plugin can read the actual allocation from `kai_context` on `api.models.chat`, or the `x-kai-context-size` response header from `api.models.request`, including streaming responses. The model list's `contextSize` remains the permitted ceiling. `api.runtime.status()` reports the active `contextSize`, `requestedContextSize` and `contextVerified` state.

Plugins choose which messages, documents and memories to send. A manual settings action and the `models.manage` permission are unnecessary for ordinary inference or an optional context requirement. The usual `inference.local` grant applies. Context requirements apply independently to each request and leave saved model preferences intact.

## Runtime verification and provider work

llama.cpp uses one parallel slot and Core reads `/props` to verify the per-slot `n_ctx`. Ollama registers each context size separately, warms a missing runner, and reads `/api/ps` to verify its `context_length`. Core checks Ollama again before acquiring a generation because the daemon can evict a model independently. Switching away releases Core's previous Ollama registration from memory. Missing or insufficient runtime evidence prevents serving the request.

Provider preparation uses the baseline. Signed network jobs allocate for their quoted input plus output tokens. The existing prepaid tariff determines which context requirements network clients can request. A larger requested window is rejected during request validation when it exceeds that tariff, before creating spending terms. Larger paid-network windows require a matching scheduler/protocol rollout.

The engine verification approach follows the contribution in [kaiapp PR #10](https://github.com/therexdev/kaiapp/pull/10). This implementation integrates it with Foundation's per-request API and generation queue.
