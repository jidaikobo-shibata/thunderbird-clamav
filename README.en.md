# ClamAV Mail Check

This Thunderbird extension scans messages locally with ClamAV. This branch builds **0.20.0a12**, a prerelease of the integrated Ubuntu/macOS/Windows scanner. No separately installed helper or Native Messaging registration is required. The published 0.20.0a5 release targets Ubuntu; a12 has not been published.

## Requirements

- Thunderbird 153.x, or 160.x on Windows. Earlier Ubuntu validation used 153.7.0esr; this macOS work uses 153.5.1esr on macOS 15.6.1, Apple Silicon. See [validation results and limitations](experiments/direct-runtime/README.md).
- Install ClamAV and current definitions separately. Ubuntu and macOS require Python 3.10+.
- Windows 11 x64 was tested with Thunderbird 153.7.0 ESR and 160.0, ClamAV 1.5.5 and Python 3.15.2. See the Windows setup below.
- macOS: standard Homebrew ClamAV, with either Homebrew Python or Python from python.org. Intel Mac paths are implemented but hardware validation remains outstanding.
- Ubuntu: `/usr/bin/python3`, `/usr/bin/clamscan`, and optionally `/usr/sbin/clamd` for repeated scans. Snap/Flatpak is not validated.

Version 0.20.0a7 was reported working well by users on Ubuntu and Apple Silicon Mac. Intel Mac hardware validation is planned and remains outstanding. The app name no longer includes “Experimental”; distribution remains a prerelease.

## Install prerequisites

On Ubuntu/Debian, this command changes OS packages:

```bash
sudo apt install clamav clamav-daemon clamav-freshclam
```

On macOS with Homebrew already installed, this adds ClamAV, Python and necessary package dependencies. Omit `python` if a supported python.org installation already exists:

```bash
brew install clamav python
```

Complete the first FreshClam definition update before scanning. The extension uses `/opt/homebrew/var/lib/clamav` on Apple Silicon and `/usr/local/var/lib/clamav` on Intel. Settings displays commands for your CPU. Example for Apple Silicon, when no existing FreshClam configuration is available:

```bash
mkdir -p /opt/homebrew/var/lib/clamav
(
  set -C
  printf '%s\n' \
    'DatabaseDirectory /opt/homebrew/var/lib/clamav' \
    'DatabaseMirror database.clamav.net' \
    > "$HOME/clam-mail-freshclam.conf"
)
freshclam --config-file="$HOME/clam-mail-freshclam.conf"
```

Creation refuses to overwrite an existing configuration file; inspect it if this fails. On Intel, replace `/opt/homebrew` with `/usr/local`. FreshClam downloads from the official mirror. Repeat the FreshClam command regularly: definitions older than three days prevent a completed scan. The extension does not configure automatic definition updates. See the [official ClamAV installation guide](https://docs.clamav.net/manual/Installing/Packages.html).

No `brew services` registration is needed. The extension starts its own foreground scanner only when required. Do not disable signatures, Gatekeeper or other protections. Additional Full Disk Access is not part of this procedure.

Executable discovery uses fixed installation locations, validates symlink targets and ownership/permissions, and checks versions. Python candidates are standard Homebrew locations and `/Library/Frameworks/Python.framework/Versions/Current/bin/python3`. The macOS-provided Python is not used. Arbitrary commands, paths and ClamAV options cannot be supplied through messages or the UI. Custom Homebrew prefixes, MacPorts and ClamXAV installations are outside this version's supported paths; existing products and services are left in place.

### Windows x64

Use Thunderbird 153.x or 160.x, the official x64 ClamAV MSI in its default Program Files location, and a per-user installation of 64-bit python.org CPython 3.13, 3.14 or 3.15. The extension checks the default Python install manager and classic installer directories under `%LOCALAPPDATA%` (`Python\pythoncore-3.XX-64` or `Programs\Python\Python3XX`). Reparse points are rejected. Keep the default installation directory permissions. [ClamAV downloads](https://www.clamav.net/downloads) and [Python for Windows](https://www.python.org/downloads/windows/).

Under the same Windows account, both apps default to `%LOCALAPPDATA%\ClamAV\database`. Upgrade the add-on first, stop any scheduled tasks that invoke FreshClam directly, then enable updates in clamav-gui. Existing legacy GUI selections follow the shared folder after the GUI completes its first update and verifies the definitions. Retry mail scans interrupted by an update.

Without the GUI, run the following in a regular PowerShell session. If a scan holds the lock, retry when the scan finishes.

~~~powershell
$db = Join-Path $env:LOCALAPPDATA "ClamAV\database"
New-Item -ItemType Directory -Force $db -ErrorAction Stop | Out-Null
$path = Join-Path (Split-Path $db) "freshclam.lock"
$lock = [IO.File]::Open($path, 'OpenOrCreate', 'ReadWrite', 'ReadWrite')
try {
    $lock.Lock(0, 1)
    $conf = Join-Path $db "mail-freshclam.conf"
    if (!(Test-Path -LiteralPath $conf)) { "DatabaseMirror database.clamav.net" | Out-File -Encoding ascii -NoClobber -ErrorAction Stop $conf }
    & "$env:ProgramFiles\ClamAV\freshclam.exe" "--config-file=$conf" "--datadir=$db"
    if ($LASTEXITCODE -ne 0) { throw "FreshClam exit $LASTEXITCODE" }
} finally {
    $lock.Dispose()
}
~~~

Repeat these commands to refresh definitions. Definitions older than three days prevent scanning. Install the XPI and check the connection in Settings. Windows starts clamscan for each message. Folder scans take longer because each process loads its own definitions. No daemon service or helper registration is required. The supported configuration uses the standard local installation directories and their default access controls. Windows ARM64, 32-bit Thunderbird and other Thunderbird major versions are outside this build’s scope.

Install an update over the existing XPI to retain settings and history. Remove the extension in Add-ons Manager. Python, ClamAV and the per-user FreshClam configuration and database remain installed.

## Build and install the XPI

No additional Python or npm packages are needed:

```bash
python3 -B scripts/build_direct_mail_check.py
```

For Thunderbird 160 on Windows, build with `python scripts/build_direct_mail_check.py --thunderbird-major 160`. Install `dist/clam-mail-check-direct-0.20.0a12-tb160.xpi` for 160.x or `dist/clam-mail-check-direct-0.20.0a12.xpi` for 153.x through Thunderbird's Add-ons Manager → gear menu → Install Add-on From File. The Experiment API requires full access to Thunderbird and the computer. Existing confirmations for quarantine and permanent deletion remain.

Open Settings and choose Check connection again. Start with a small manual folder scan. Automatic scanning is disabled for a new installation; select accounts only after checking results.

## Update and remove

Install the newer XPI **over the existing extension without removing it first**. The add-on ID, settings, history, review notes and interrupted-work data are retained; the integrated scanner updates with the XPI.

Remove the extension through Thunderbird's Add-ons Manager. Normal extension settings/history may be lost. Messages, accounts, Python, ClamAV, definitions, FreshClam configurations and any older helpers remain. A migration backup, if previously created inside the profile, also remains and is not restored or erased automatically.

## Results and privacy

Encrypted content, scan limits, missing software and communication failures are reported as incomplete or failed, never as a clean scan. A previous malware detection is retained when a rescan fails. A clean result does not guarantee safety.

Message bodies and attachments are passed only to local scanner processes and are not stored in history. Temporary scan files are cleaned at scanner shutdown. Sender, subject, detection names and review notes are stored in Thunderbird's local extension storage. The extension sends no messages, results or usage telemetry to an external service. FreshClam's separate definition downloads require network access.

## Tests

Use disposable profiles and synthetic messages, never your normal profile or real mail:

```bash
node --test tests/*.test.mjs
python3 -B -m unittest discover -s tests
python3 -B scripts/smoke_direct_mail_check.py
```

The legacy Linux GUI launcher test is skipped on macOS. OS-specific validation and remaining limitations are listed in the [runtime notes](experiments/direct-runtime/README.md). Source and release publication require a separate user instruction.

## Recovering from startup storage errors

If initialization fails, check available storage space and access, then use Check connection again in Settings to retry. Scanning and settings changes remain blocked until recovery. If saving a new folder scan fails, the previous scan progress and resume checkpoints are retained.
