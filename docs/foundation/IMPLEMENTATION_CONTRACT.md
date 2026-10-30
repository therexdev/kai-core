# Foundation implementation contract

Core owns shared services and the application host. Each plugin owns its feature engines, assets, dependencies and saved data. The Foundation profile starts fresh and leaves previous installations untouched.

The supported package format is schema 2, API 3. The native service API is version 1. The authoritative API reference and examples are in [PLUGIN_AUTHOR_GUIDE.md](PLUGIN_AUTHOR_GUIDE.md) and [api-v1.d.ts](api-v1.d.ts). See [ARCHITECTURE.md](ARCHITECTURE.md) for lifecycle, storage, permission and trust boundaries.

Native extensions run with full computer and application trust. Permissions describe SDK usage; they are not an operating-system sandbox. Remote job graphs receive neither the native SDK nor the local plugin service bus.
