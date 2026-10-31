# KAI Core Beta 0.7.13

Adds Liquid LFM3 1.7B to the approved network catalog after the matching scheduler update. It remains a separate model alongside Qwen 2.5 1.5B. Its verified Q4_K_M package uses the upstream non-thinking template for network inference, at 10 input / 40 output credits per million tokens, with a 4,096-token context and 256-token output limit.

The catalog extension preserves existing payment identities, model prices, provider device authorizations and saved request recovery. Older schedulers continue returning their existing catalog. Installing Liquid alone does not make it available: a sharing provider must pass the signed readiness checks, and network chat still excludes the customer's own provider.

Validation covers catalog tampering and compatibility, durable credit recovery, locked-wallet device qualification and paid replies over real loopback HTTP with controlled inference/chain fixtures, plus the native Foundation checks. Full-weight Liquid tokenizer and readiness measurements are recorded in the scheduler repository. Tests do not claim a live provider is online or spend real funds.
