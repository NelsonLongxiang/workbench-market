# Odoo readonly preflight (Windows operator tool)

This tool does not create Odoo accounts/fields, enable lifecycle approval, or synchronize users. It discovers account-type metadata and queries model ACLs using only authenticate, fields_get and check_access_rights. A read-only ACL result is **not** proof of row/field minimization. No user records are exported.

## Local setup

PowerShell 7 on the deployment host, run as its service user. Store connection JSON outside the checkout in the protected directory used by the issuer. Actual host, database and username belong in local configuration, not this public repository. Example schema:

~~~json
{"url":"https://odoo.example.invalid","database":"DATABASE","username":"SERVICE_USER","account_type_field":null,"credential_store":"odoo-sync.credential.xml"}
~~~

The directory ACL must allow only the current service user and SYSTEM. The helper rejects a symlink/reparse store and refuses to overwrite a credential. Provision a dedicated account with no create/write/unlink rights; independently check row/field scope and inherited groups. Never use an administrator as the sync account.

To store a **rotated** password once without making a network request:

~~~powershell
pwsh -NoProfile -File scripts/ops/odoo-readonly-preflight.ps1 -Configure -StoreOnly
~~~

Input is hidden. Export-Clixml encrypts the PSCredential with Windows DPAPI, bound to the user and machine. No password in arguments, environment, logs or repository. Do not run under a transcript/debugger that records secret input. Do not submit credentials through agent chat.

To store and immediately probe an approved HTTPS endpoint, omit -StoreOnly. After configuration, rerun without -Configure to probe. No daemon or polling is installed. Plain HTTP is refused by default; prefer HTTPS or an approved encrypted tunnel. -AllowInsecureHttp is an explicit **operator** override accepting plaintext network transmission, never a default or agent-set flag.

A missing metadata field may mean it is not visible to this service account. Do not infer schema absence or default accounts to human. The probe does not change account_type_field automatically and does not claim live sync is implemented. Its JSON report leaves minimal_readonly_proven and sync_ready false even if model write rights are denied. Unknown ACL results fail closed.

## GitHub operator actions

Actions Secrets and local service credentials are separate stores. Only if an approved workflow needs the password, a credential-authorized human runs:

~~~sh
gh secret set ODOO_PASSWORD -R NelsonLongxiang/yuanguang-lifecycle-os
~~~

The CLI prompts for the value; do not supply it as a command argument or paste it into chat. Storing a GitHub secret alone does not configure this deployment host or add a workflow consumer.

PR approval must use an authorized login different from the author, after reviewing the actual final SHA:

~~~sh
gh auth status
gh pr view 267 -R NelsonLongxiang/workbench-market --json headRefOid,author,statusCheckRollup
gh pr review 267 -R NelsonLongxiang/workbench-market --approve
~~~

For PR268, do not approve until the known same-origin SOP approval boundary is resolved and independent final-SHA adversarial tests/CI pass. No self-approval, admin bypass, automatic merge or deployment is performed by these helpers.

## Verification

~~~powershell
pwsh -NoProfile -File scripts/ops/odoo-readonly-preflight-test.ps1
~~~

Synthetic unit tests only. They neither access a real credential store nor call Odoo. Live permissions, transport and schema remain unverified until a credential-authorized operator configures the store and runs the probe.
