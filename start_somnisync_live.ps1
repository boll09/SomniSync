$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($node) { $node.Source } else { $null }
if (-not $nodePath) {
    $commonNodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $commonNodePath) {
        $nodePath = $commonNodePath
    }
}
if (-not $nodePath) {
    throw 'Node.js was not found. Install Node.js LTS, open a new PowerShell window, and try again.'
}

$accountSid = $env:ACCOUNT_SID
if (-not $accountSid) {
    $accountSid = Read-Host 'Twilio Account SID'
}
if ($accountSid -notmatch '^AC[0-9a-fA-F]{32}$') {
    throw 'The Account SID format is invalid.'
}

$secureToken = Read-Host 'New Twilio Auth Token (input is hidden)' -AsSecureString
$tokenPointer = [IntPtr]::Zero
$authToken = $null
try {
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $authToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
}
finally {
    if ($tokenPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
    $secureToken.Dispose()
}

if ([string]::IsNullOrWhiteSpace($authToken)) {
    throw 'The Auth Token cannot be empty.'
}

$contactNumber = $env:EMERGENCY_CONTACT
if (-not $contactNumber) {
    $contactNumber = Read-Host 'Emergency contact number (E.164, only use a consenting recipient)'
}
$contactNumber = $contactNumber -replace '[\s().-]', ''
if ($contactNumber -notmatch '^\+[1-9]\d{6,14}$') {
    $authToken = $null
    throw 'Phone numbers must use E.164 format, for example +15551234567.'
}

$env:ACCOUNT_SID = $accountSid
$env:AUTH_TOKEN = $authToken
$env:EMERGENCY_CONTACT = $contactNumber
$authToken = $null

Push-Location $PSScriptRoot
try {
    Write-Host ''
    Write-Host 'SomniSync is starting in DRY-RUN mode.'
    Write-Host 'Open http://127.0.0.1:3000/ and explicitly select Live call to enable real calls.'
    Write-Host 'Keep this PowerShell window open. Press Ctrl+C here to stop the server.'
    & $nodePath .\somnisync_sim.js
}
finally {
    Pop-Location
    Remove-Item Env:ACCOUNT_SID -ErrorAction SilentlyContinue
    Remove-Item Env:AUTH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:EMERGENCY_CONTACT -ErrorAction SilentlyContinue
}
