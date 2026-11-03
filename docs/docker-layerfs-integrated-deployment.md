# Docker deployment: Workbench with required LayerFS

This guide describes a generic deployment shape. Substitute local service names and host addresses; do not publish internal hostnames, IP addresses, volume/container names, image digests, operator paths, credentials, or deployment-session notes.

## Required topology

- The standard Compose stack starts Workbench and LayerFS together. Workbench depends on LayerFS health; missing LayerFS configuration is a hard failure, not a silent fallback.
- Keep LayerFS on a private internal network with no published host port. Only the LayerFS service may receive the Docker socket when the reviewed lifecycle contract requires it; this grants host-root-equivalent authority and requires explicit owner approval and a maintenance window.
- Keep Workbench and LayerFS data in separate persistent volumes. Store service credentials in a file-backed secret outside the repository, readable only by the required container UID.
- Publish only the business surface to the required interface. The optional control surface must remain disabled unless the owner explicitly opts in; if enabled, bind it to loopback and access it through an authenticated administrator path.

## Build and update

1. Build Workbench only from a clean checkout of reviewed, merged main. Never build a production image from an unreviewed feature branch or dirty tree.
2. Prepare LayerFS source from the exact reviewed commit pin using deploy/build-layerfs.sh; verify its generated manifest before building.
3. Run the Compose contract check and unit/smoke tests. Generate CycloneDX SBOMs into a protected release-artifact directory outside this public source tree; attach reviewed artifacts to a release or retain them in an access-controlled repository. Do not commit generated SBOM JSON here.
4. Before an update, stop writers and create protected backups of application data, LayerFS data, and required lifecycle state. Verify checksums and SQLite integrity; perform a restore check in an isolated environment.
5. After review PASS and merge, record the exact merged source SHA and immutable image digests in the private operations record. Deploy only during an owner-approved maintenance window; never use down -v.

## Recovery archive safety

Treat encrypted archives as untrusted input. Enforce compressed-file size, expanded-byte, member-count, and wall-clock limits; accept only regular files and directories with safe relative paths; reject duplicate paths, links, and special files. Validate the complete archive before extraction, then authenticate an independently generated post-extraction manifest before allowing recovery. Restore first into an isolated empty target and verify SQLite integrity and application-level cold reads.

## Release gates

- Compose resolves with required LayerFS dependency, health checks, internal networking, no LayerFS host port, and no secret in environment or source control.
- Runtime isolation confirms Workbench has no Docker socket and LayerFS has no published port; verify non-root service identities where supported.
- Exercise publish, cold read, draft/apply/merge, backup, restore, delete and same-name recreation against disposable projects only.
- Run static checks, archive-safety tests, SBOM integrity/provenance validation, security scans, and all relevant application smokes. A partial inventory is not a complete image SBOM or vulnerability/license scan.
- Do not deploy until a non-self reviewer has passed the exact SHA and the owner has approved the target and maintenance window.
