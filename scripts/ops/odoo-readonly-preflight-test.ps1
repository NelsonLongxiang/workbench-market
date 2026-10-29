# Pure synthetic unit tests: no secret store, Odoo request or production data access.
param([string]$ScriptPath = (Join-Path $PSScriptRoot 'odoo-readonly-preflight.ps1'))
$ErrorActionPreference = 'Stop'
. $ScriptPath -LibraryOnly
$passed = 0
$failed = 0
function Check([string]$Name, [scriptblock]$Body) {
  try { & $Body; Write-Host "PASS $Name"; $script:passed++ }
  catch { Write-Host "FAIL $Name : $($_.Exception.Message)"; $script:failed++; }
}
function Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw 'Mismatch' } }
$fields = @{ x_kind = @{ string='账号类型'; type='selection'; selection=@(@('human','人'),@('agent','agent'),@('system','系统')) } }
$readOnly = @{ read=$true; create=$false; write=$false; unlink=$false }
Check 'field_found_no_auto_bind' { Equal (Get-OdooMetadataVerdict $fields $readOnly '').field_state 'ONE_CANDIDATE_NOT_YET_BOUND' }
Check 'bound_field_still_needs_mapping' { Equal (Get-OdooMetadataVerdict $fields $readOnly 'x_kind').field_state 'FOUND_VERIFY_SELECTION_MAPPING' }
Check 'missing_not_assumed_absent' { Equal (Get-OdooMetadataVerdict @{} $readOnly '').field_state 'NOT_FOUND_OR_NOT_VISIBLE_NEEDS_ADMIN_METADATA' }
Check 'ambiguous_no_guess' {
  $f=@{ a=$fields.x_kind; b=$fields.x_kind }
  Equal (Get-OdooMetadataVerdict $f $readOnly '').field_state 'AMBIGUOUS_DO_NOT_GUESS'
}
Check 'metadata_label_without_selection_safe' {
  $v=Get-OdooMetadataVerdict @{field=@{string='账号类型';type='char'}} $readOnly ''
  Equal $v.field_candidates[0].selection.Count 0
}
Check 'model_readonly_not_full_scope' { Equal (Get-OdooMetadataVerdict $fields $readOnly '').acl_state 'MODEL_READ_ONLY_NOT_FIELD_OR_ROW_SCOPE_PROOF' }
Check 'write_right_fails' { Equal (Get-OdooMetadataVerdict $fields @{read=$true;create=$false;write=$true;unlink=$false} '').acl_state 'WRITE_RIGHTS_PRESENT_OR_UNKNOWN_DO_NOT_USE_FOR_SYNC' }
Check 'unknown_write_fails' { Equal (Get-OdooMetadataVerdict $fields @{read=$true;create=$false;write=$false} '').acl_state 'WRITE_RIGHTS_PRESENT_OR_UNKNOWN_DO_NOT_USE_FOR_SYNC' }
Check 'non_boolean_false_not_trusted' { Equal (Get-OdooMetadataVerdict $fields @{read=$true;create='false';write=$false;unlink=$false} '').acl_state 'WRITE_RIGHTS_PRESENT_OR_UNKNOWN_DO_NOT_USE_FOR_SYNC' }
Check 'read_denied' { Equal (Get-OdooMetadataVerdict $fields @{read=$false;create=$false;write=$false;unlink=$false} '').acl_state 'READ_NOT_PROVEN' }
Check 'never_claim_sync_ready' { $v=Get-OdooMetadataVerdict $fields $readOnly ''; Equal $v.sync_ready $false; Equal $v.minimal_readonly_proven $false }
Check 'RPC_shape_preserves_empty_positional_args' {
  $prefix=@('SYNTHETIC_DB',2,'SYNTHETIC_NOT_REAL','res.users')
  $a=$prefix+@('fields_get',@(),@{attributes=@('string','type','selection')})
  Equal $a.Count 7
  Equal $a[5].Count 0
}
Check 'credential_securestring_remains_valid_until_use' {
  $s=ConvertTo-SecureString 'SYNTHETIC_NOT_A_REAL_PASSWORD' -AsPlainText -Force
  $c=[pscredential]::new('synthetic',$s); $s=$null
  Equal ($c.GetNetworkCredential().Password -eq 'SYNTHETIC_NOT_A_REAL_PASSWORD') $true
  $c.Password.Dispose()
}
Check 'HTTP_guard_before_store_or_network' {
  $text=[IO.File]::ReadAllText($ScriptPath)
  Equal ($text.IndexOf('if ($http -and -not $PermitHttp -and -not $OnlyStore)') -lt $text.IndexOf('Read-Host')) $true
  Equal ($text.IndexOf('if ($http -and -not $PermitHttp -and -not $OnlyStore)') -lt $text.IndexOf('$credential = Import-Clixml')) $true
}
@{passed=$passed;failed=$failed;evidence='SYNTHETIC_UNIT_ONLY';odoo_requests=0;real_credentials_read=$false}|ConvertTo-Json -Compress
if ($failed) { exit 1 }
