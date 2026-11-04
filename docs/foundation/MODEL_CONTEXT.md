# Local model context windows

Core uses the native configured context for each pinned catalog model. These are total input + output windows, not output-token limits. Users can select a smaller window in **Models → Context**; the saved choice is shared by Core Chat and plugins using Core's local runtime.

| Catalog model | Default / supported ceiling | Primary configuration or model card |
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

## User choices and hardware

The selector offers powers of two from 4K up to the known model limit (or 2K for an imported model with a 2K native window). The 4K catalog floor preserves existing network provider capacity. **Model default** removes the package-specific override. A custom model with an unreadable header retains its previous default (4K for a new import), clearly reports an unknown model limit, and permits an explicit choice up to Core's 256K administrative ceiling. That ceiling is not a claim that an unknown model supports 256K.

More context requires additional KV-cache memory and increases the work needed to process long prompts. Native context support does not guarantee that the maximum fits a particular computer. Choose a smaller window if startup fails or memory use is too high; Core does not silently substitute a smaller context. Existing minimum-RAM hints describe model weights and are not full-context memory estimates.

New imports read at most the first 1 MiB of GGUF v2/v3 metadata, looking for `general.architecture` and its matching `*.context_length`. Existing imports are inspected once during startup. Unknown, inaccessible, oversized or malformed metadata falls back without changing model files. Settings remain keyed to package identity, so changing an alias does not lose a saved choice.

## Runtime and consumers

llama.cpp receives the effective `--ctx-size` and one parallel slot, matching Core's serialized generation queue. Ollama registrations include `num_ctx` and a context-specific model name, so an old cached registration cannot silently retain 4K. The same alias reloads on its next request when its context changed. Settings cannot change while a generation or model preparation is active. Idle provider polling does not block the setting; the catalog floor retains the existing 4K network capacity.

The public model list exposes `contextSize`, `defaultContextSize`, `minContextSize`, `maxContextSize`, `contextOverride` and `contextLimitKnown`. Plugins should refresh that metadata before budgeting history. Core Chat uses a context-aware history budget with room for its reply, rather than the old 24 KB / 15-turn ceiling. The gateway reserves at least its normal headroom and the requested `max_tokens`; its character-based token estimate is approximate and the engine remains the final tokenizer authority. Core Chat's output limit and network request/payment limits are independent and unchanged.
