# Bundled school SDK

This directory contains the reproducible distribution of `@alms/ssu-api` version **0.3.39** used by ALMS Server. The package is installed locally from the archive by `npm ci`; access to a private registry or another repository is not required.

| Artifact | Value |
|---|---|
| File | `alms-ssu-api-0.3.39.tgz` |
| SHA-256 | `7d1c04ef42212e7d01cf92e5e0e4effe800989ed83de692c9dad2776d18aa4bf` |
| Size | 155774 bytes |
| License | MIT |

The archive is unchanged from the reviewed SDK release. Its original `package/LICENSE` is included inside the archive and copied to [LICENSES/SSU-SDK-MIT.txt](../LICENSES/SSU-SDK-MIT.txt). Package metadata and integrity are pinned in the root lockfile.

The SDK handles school-specific authentication, parsing and supported reads/writes. ALMS Server supplies session ownership, authorization, storage and the public HTTP/MCP interfaces. Refer to the server's current [HTTP contract](../docs/http-contract.md) and [MCP contract](../docs/mcp-contract.md) for the supported application interfaces.

Embedded SDK documentation may refer to earlier private development records. Those records are not required to install or use this distribution, and they are not included as public operational evidence. Older SDK archives are intentionally absent from this source snapshot.
