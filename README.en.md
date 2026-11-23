# ClamAV Mail Check

This Thunderbird extension scans messages locally with ClamAV. This branch builds **0.20.0a42**, a prerelease of the integrated Ubuntu/macOS scanner. No separately installed helper or Native Messaging registration is required. The published 0.20.0a5 release targets Ubuntu; a41 has not been published.

## Requirements

- Thunderbird 153.x. Earlier Ubuntu validation used 153.7.0esr; this macOS work uses 153.5.1esr on macOS 15.6.1, Apple Silicon. See [validation results and limitations](experiments/direct-runtime/README.md).
- Python 3.10+ and ClamAV with current definitions, installed separately.
- macOS: standard Homebrew ClamAV, with either Homebrew Python or Python from python.org. Intel Mac paths are implemented but hardware validation remains outstanding.
- Ubuntu: `/usr/bin/python3`, `/usr/bin/clamscan`, and optionally `/usr/sbin/clamd` for repeated scans. Snap/Flatpak is not validated. Windows is currently unsupported; a port is planned.

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

## Build and install the XPI

No additional Python or npm packages are needed:

```bash
python3 -B scripts/build_direct_mail_check.py
```

Install `dist/clam-mail-check-direct-0.20.0a42.xpi` through Thunderbird's Add-ons Manager → gear menu → Install Add-on From File. The Experiment API requires full access to Thunderbird and the computer. Existing confirmations for quarantine and permanent deletion remain.

Open Settings and choose Check connection again. Start with a small manual folder scan. Automatic scanning is disabled for a new installation; select accounts only after checking results.

The integrated scanner retains a healthy connection for about five seconds between bursts, then closes it. Definitions and the private runtime directory remain in use during this short idle period. Failed connections are discarded instead of reused.

## Update and remove

Install the newer XPI **over the existing extension without removing it first**. The add-on ID, settings, history, review notes and interrupted-work data are retained; the integrated scanner updates with the XPI.

Version 0.20.0a13 changes the storage format for history and resume checkpoints. Existing data is backed up inside the profile before migration; migration stops if the backup fails. Installing 0.20.0a12 or earlier over this version is not a supported downgrade. Returning to an older version requires restoring the pre-migration backup.

Remove the extension through Thunderbird's Add-ons Manager. Normal extension settings/history may be lost. Messages, accounts, Python, ClamAV, definitions, FreshClam configurations and any older helpers remain. A migration backup, if previously created inside the profile, also remains and is not restored or erased automatically.

## Results and privacy

Encrypted content, scan limits, missing software and communication failures are reported as incomplete or failed, never as a clean scan. A previous malware detection is retained when a rescan fails. A clean result does not guarantee safety.

Review changes and manual quarantine are disabled while scanning or deletion is in progress, with an explanation in the results view. Automatic row reordering preserves keyboard focus; if the target disappears, focus moves to the results summary. Invalid scan settings remain in the form with field-specific correction messages. Unsaved values are not applied to scanning.

For bulk permanent deletion, the dialog opens immediately and shows how many messages have been verified. You can cancel during verification; no messages are deleted at this stage. Once verification finishes, the same dialog displays the targets for final confirmation.

When an operation cannot be completed, a dialog explains the reason and the next step. After closing it, you can review the notice in the originating tab until the page is closed. Partial batch failures explicitly state that successful operations have already taken effect. Progress and completion messages appear in the originating tab and at the bottom of the view; input errors remain beside their fields. Refresh failures show a reload notice. Automatic scan results do not open unexpected dialogs.

Desktop notifications are submitted independently of scanning. Slow notification responses cannot hold later inspections or folder completion. Identical in-flight results are not submitted twice, and failures are not treated as delivered notices. Late responses cannot overwrite the delivery state of a newer result; relevant failures are shown in the status area.

Incoming message lists are fetched independently per notification. Accepted messages can be scanned while another list is pending. Failed listing or saving retains the unaccepted remainder for periodic retries.

Move notifications also fetch their lists independently. Later metadata is retained for replay when an earlier notification arrives late, and contents are verified before updating locations. Temporary retention is limited to 60 seconds, 1,000 notifications, and 100,000 headers. Unverifiable moves leave the location unconfirmed and show an issue in the status area.

Folder-resume checkpoint verification and post-move history verification each wait at most 10 seconds. Unverified messages remain eligible for scanning, and an unverified move does not transfer a verdict. Stopping folder enumeration cancels its pending waits. Late replies cannot change a newer job's progress or a history entry's location.

Automatic quarantine runs separately from scanning, one message at a time, with a 60-second deadline per attempt. Detection alerts and later scans continue while it waits. If completion cannot be confirmed, check both folders in Thunderbird; no automatic repeat move is attempted. Quarantine receipt identity checks wait at most 10 seconds, then fall back to normal scanning. Late replies cannot remove or overwrite newer results.

Active and queued automatic quarantine tasks are retained independently of history. History rotation or clearing the overflow summary does not cancel them. The visible limits remain 1,000 history records and 20 overflow details; task ownership is released on completion or cancellation. If a task fails after its detail has rotated out, an issue is still shown in the status area.

Automatic carry-forward checks for a previous acknowledgement wait at most 10 seconds. If the message contents cannot be verified in time, the result requires review again and later inspections continue. Late responses cannot replace a later human decision.

Message bodies and attachments are passed only to local scanner processes and are not stored in history. Temporary scan files are cleaned at scanner shutdown. Sender, subject, detection names, review dates and previously entered review notes are stored in Thunderbird's local extension storage. The extension sends no messages, results or usage telemetry to an external service. FreshClam's separate definition downloads require network access.

## Tests

Use disposable profiles and synthetic messages, never your normal profile or real mail:

```bash
node --test tests/*.test.mjs
python3 -B -m unittest discover -s tests
python3 -B scripts/smoke_direct_mail_check.py
```

The legacy Linux GUI launcher test is skipped on macOS. OS-specific validation and remaining limitations are listed in the [runtime notes](experiments/direct-runtime/README.md). Source and release publication require a separate user instruction.

Draft folders are excluded from automatic new-mail scanning, using Thunderbird’s draft-folder attribute rather than their names. Explicit message and folder scans remain available. Other folder types remain eligible for automatic scanning, and existing history is retained.

## Recovering from startup storage errors

If initialization fails, check available storage space and access, then use Check connection again in Settings to retry. Scanning and settings changes remain blocked until recovery. If saving a new folder scan fails, the previous scan progress and resume checkpoints are retained.

If incoming reception cannot be saved, the failed message and remaining reception are retained in memory and retried every ten seconds. Later deliveries and manual scans can continue. Keep Thunderbird open until the pending-reception notice clears: unsaved reception cannot be restored if Thunderbird exits before storage recovers.

## Moving messages

Ordinary move events update the location of existing history after verifying the message contents. Verdicts and review notes are retained. Subsequent incoming notifications for the updated message do not add another history entry. Moves during scanning do not restore stale location information. Unreadable or ambiguous matches are not automatically linked, and copies remain separate messages. Duplicate histories created by earlier versions are not automatically deleted or merged.
