# YGL-trees container candidate

This directory contains an isolated, disposable Docker candidate for ygl-trees 0.119.0. It is not a production deployment recipe and must not be pointed at an existing database, container, network, or persistent volume.

The default stack stores state in a local named volume and uses a private internal network. The optional PostgreSQL profile is an analytical mirror only; SQLite remains authoritative. The PG mirror does not provide PostgreSQL-backed MCP write semantics. Test only against a newly created disposable PostgreSQL instance with an external protected secret file.

Before any use, inspect the rendered Compose configuration, confirm project and volume names are unique to the disposable test, and verify no host ports or existing services are selected. Keep secrets and generated runtime data outside source control.
