# KAI Core 0.7.4

Installed plugins and marketplace cards have a more readable responsive layout, with room for titles and complete descriptions, clear status badges, and consistent action placement. Catalog-listed plugins show their GitHub repository owner and a small accessible GitHub link. Links open through Core's reviewed external-browser flow. Installed attribution requires the same plugin ID and publisher fingerprint; unlisted packages do not receive a guessed developer identity.

Native plugin installation now describes access as KAI's existing operating-system permissions. Native code can access files and application data available to KAI, run programs and connect to the network. Declared KAI API capabilities do not sandbox native code, and installing a plugin does not automatically grant administrator access. Sandboxed plugins retain their separate restricted-access explanation. These changes clarify the existing runtime rather than changing its authority.

This is a Core update; the current plugin releases remain compatible. Wallets, models, installed plugins and their saved-data locations stay unchanged. Core updates remain manual.
