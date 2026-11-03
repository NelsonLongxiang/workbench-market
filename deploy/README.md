# Workbench deployment notes

The standard Compose stack requires LayerFS and exposes the business surface only. The control surface is disabled by default: WM_CONTROL_PORT is unset, no host port 9801 is published, and the base healthcheck tests only the business API. An owner may explicitly opt in by adding docker-compose.control.yml; that overlay binds control to 127.0.0.1, enables WM_CONTROL_PORT=9801, and extends the healthcheck to verify the control surface identity. Never expose the control port on a LAN/public interface.

Credentials remain in the existing owner-controlled deployment secret/config; never copy them into source, shell history, URLs, or logs.
