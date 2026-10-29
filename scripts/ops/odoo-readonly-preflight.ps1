# Credential input is operator-only. The agent never supplies or sees it.
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config/yuanguang-lifecycle-os/odoo-sync.connection.json'),
  [switch]$Configure,
  [switch]$StoreOnly,
  [switch]$AllowInsecureHttp,
  [switch]$LibraryOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-OdooCredentialStoreName {
  param([string]$Name)
  $valid = (-not [string]::IsNullOrWhiteSpace($Name)) -and ($Name -notin @('.', '..')) -and ($Name -match '^[A-Za-z0-9][A-Za-z0-9._-]*$') -and ($Name -notmatch '[. ]$') -and ($Name -notmatch '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.]|$)')
  return [bool]$valid
}

function Get-OdooMetadataVerdict {
  param([System.Collections.IDictionary]$Fields, [System.Collections.IDictionary]$Rights, [string]$RequestedField)
  $candidates = @()
  foreach ($name in $Fields.Keys) {
    $field = $Fields[$name]
    $keys = @(); $labels = @()
    if ($field.Contains('selection') -and $field.selection) {
      foreach ($pair in $field.selection) { $keys += [string]$pair[0]; $labels += [string]$pair[1] }
    }
    if (($RequestedField -and $name -eq $RequestedField) -or
        ($field.Contains('string') -and $field.string -eq '账号类型') -or
        ($labels -contains '人' -and $labels -contains 'agent' -and $labels -contains '系统') -or
        ($keys -contains '人' -and $keys -contains 'agent' -and $keys -contains '系统')) {
      $selection = @()
      if ($field.Contains('selection')) { $selection = @($field.selection) }
      $candidates += @{ name = $name; type = $field.type; selection = $selection }
    }
  }
  $fieldState = if ($RequestedField -and $candidates.Count -eq 1 -and $candidates[0].name -eq $RequestedField) { 'FOUND_VERIFY_SELECTION_MAPPING' }
    elseif ($candidates.Count -eq 1) { 'ONE_CANDIDATE_NOT_YET_BOUND' }
    elseif ($candidates.Count -gt 1) { 'AMBIGUOUS_DO_NOT_GUESS' }
    else { 'NOT_FOUND_OR_NOT_VISIBLE_NEEDS_ADMIN_METADATA' }
  $allDenied = $true
  foreach ($action in @('create','write','unlink')) { if (-not $Rights.Contains($action) -or $Rights[$action] -isnot [bool] -or $Rights[$action]) { $allDenied = $false } }
  $aclState = if (-not $Rights.Contains('read') -or $Rights.read -isnot [bool] -or -not $Rights.read) { 'READ_NOT_PROVEN' }
    elseif ($allDenied) { 'MODEL_READ_ONLY_NOT_FIELD_OR_ROW_SCOPE_PROOF' }
    else { 'WRITE_RIGHTS_PRESENT_OR_UNKNOWN_DO_NOT_USE_FOR_SYNC' }
  return @{ field_state = $fieldState; field_candidates = $candidates; model_rights = $Rights; acl_state = $aclState;
    minimal_readonly_proven = $false; sync_ready = $false;
    remaining = @('server-side field/row scope not independently established','live sync adapter not implemented by this probe','principal mirror and ops assertion not exercised') }
}

function Invoke-OdooReadonlyRpc {
  param([string]$Endpoint, [string]$Service, [string]$Method, [object[]]$RpcArgs)
  $body = @{jsonrpc='2.0'; method='call'; id=1; params=@{service=$Service; method=$Method; args=$RpcArgs}} | ConvertTo-Json -Depth 15 -Compress
  try {
    $response = Invoke-WebRequest -Uri $Endpoint -Method Post -ContentType 'application/json' -Body $body -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop
    $parsed = ConvertFrom-Json -AsHashtable -InputObject $response.Content
    if ($parsed.Contains('error') -or -not $parsed.Contains('result')) { throw 'RPC rejected' }
    return $parsed.result
  } catch { throw 'Odoo RPC failed or redirected; server response omitted to prevent credential disclosure.' }
  finally { $body = $null; $response = $null; $parsed = $null }
}

function Invoke-OdooReadonlyPreflight {
  param([string]$ConnectionPath, [switch]$ConfigureCredential, [switch]$OnlyStore, [switch]$PermitHttp)
  if (-not $IsWindows) { throw 'This credential store requires Windows DPAPI and PowerShell 7.' }
  $cfg = Get-Content -LiteralPath $ConnectionPath -Raw | ConvertFrom-Json -AsHashtable
  $uri = [uri]$cfg.url
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Require a plain approved Odoo origin without userinfo, path, query or fragment.' }
  $http = $uri.Scheme -eq 'http'
  if ($http -and -not $PermitHttp -and -not $OnlyStore) { throw 'Plain HTTP would expose the credential on the network. Use HTTPS or an approved encrypted tunnel; -AllowInsecureHttp requires the operator to explicitly accept this transport risk.' }
  if ($http -and -not $OnlyStore) { Write-Warning 'Explicit operator override: this connection transmits a password over plain HTTP. Prefer HTTPS or an encrypted tunnel.' }
  if (-not $cfg.database -or -not $cfg.username) { throw 'Missing non-secret database or username.' }
  $dir = Split-Path -Parent $ConnectionPath
  if (-not (Test-OdooCredentialStoreName ([string]$cfg.credential_store))) { throw 'Credential store must be a non-empty safe filename, not a path, reserved device or dot directory.' }
  $store = Join-Path $dir $cfg.credential_store
  if ($OnlyStore -and -not $ConfigureCredential) { throw '-StoreOnly requires -Configure.' }
  if ((Get-Item -Force -LiteralPath $ConnectionPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse configuration refused.' }
  if ((Get-Item -Force -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse store directory refused.' }
  if ((Test-Path -LiteralPath $store) -and ((Get-Item -Force -LiteralPath $store).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse credential store refused.' }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $dir
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -eq 'Allow') {
      $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($sid -notin @($me, 'S-1-5-18')) { throw 'Credential directory allows another identity. Restrict it to this service user and SYSTEM first.' }
    }
  }
  if ($ConfigureCredential) {
    if (Test-Path -LiteralPath $store) { throw 'Credential already exists. Rotate through the approved operator procedure; no automatic overwrite.' }
    # Never pass a password on a CLI argument, environment variable, transcript or stdout.
    $secure = Read-Host 'Enter the ROTATED Odoo password (hidden; do not paste into chat)' -AsSecureString
    if ($secure.Length -eq 0) { throw 'Empty password refused.' }
    $credential = [pscredential]::new([string]$cfg.username, $secure)
    $credential | Export-Clixml -LiteralPath $store -NoClobber
    $secure = $null
    Write-Host 'Encrypted credential stored for this Windows user on this machine. The password was not printed.'
  } else {
    if (-not (Test-Path -LiteralPath $store)) { throw 'Credential not configured. Run once with -Configure as the service account.' }
    $credential = Import-Clixml -LiteralPath $store
  }
  if ($OnlyStore) { $credential.Password.Dispose(); $credential = $null; return }
  if ($credential.UserName -ne $cfg.username) { throw 'Stored account does not match connection configuration.' }
  $password = $null
  try {
    $password = $credential.GetNetworkCredential().Password
    $endpoint = $uri.AbsoluteUri.TrimEnd('/') + '/jsonrpc'
    $uid = Invoke-OdooReadonlyRpc $endpoint 'common' 'authenticate' @($cfg.database, $cfg.username, $password, @{})
    if ($uid -isnot [long] -and $uid -isnot [int]) { throw 'Authentication failed; no credentials or response will be logged.' }
    if ($uid -le 0) { throw 'Authentication failed.' }
    $prefix = @($cfg.database, $uid, $password, 'res.users')
    $fields = Invoke-OdooReadonlyRpc $endpoint 'object' 'execute_kw' ($prefix + @('fields_get', @(), @{attributes=@('string','type','selection')}))
    if ($fields -isnot [System.Collections.IDictionary]) { throw 'Unexpected metadata shape.' }
    $rights = @{}
    foreach ($action in @('read','create','write','unlink')) {
      $right = Invoke-OdooReadonlyRpc $endpoint 'object' 'execute_kw' ($prefix + @('check_access_rights', @($action), @{raise_exception=$false}))
      $rights[$action] = $right
    }
    $verdict = Get-OdooMetadataVerdict $fields $rights ([string]$cfg.account_type_field)
    $result = @{ schema='odoo-readonly-preflight/1'; checked_at=[datetime]::UtcNow.ToString('o'); authentication='SUCCESS'; transport= $(if($http){'HTTP_EXPLICIT_OPERATOR_OVERRIDE'}else{'HTTPS'}); evidence_layer='LIVE_METADATA_AND_MODEL_ACL_ONLY'; production_writes=0; secret_values_logged=$false; verdict=$verdict }
    $result | ConvertTo-Json -Depth 12
    if ($verdict.acl_state -ne 'MODEL_READ_ONLY_NOT_FIELD_OR_ROW_SCOPE_PROOF') { throw 'Not safe to use this account as read-only sync; inspect the redacted ACL result.' }
  } finally { $password = $null; $prefix = $null; if ($credential) { $credential.Password.Dispose() }; $credential = $null; $uid = $null }
}

if (-not $LibraryOnly) {
  try { Invoke-OdooReadonlyPreflight -ConnectionPath $ConfigPath -ConfigureCredential:$Configure -OnlyStore:$StoreOnly -PermitHttp:$AllowInsecureHttp }
  catch { [Console]::Error.WriteLine('Preflight stopped. No secret or raw Odoo response is included. ' + $_.Exception.Message); exit 1 }
}
