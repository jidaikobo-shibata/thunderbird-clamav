"""User-scoped installer, separate from the mail scanning protocol."""
# Translation catalog; keep protocol/status values independent of language.
_LANGUAGE = "ja"
_EN_MESSAGES = {'同梱の導入用ファイルを読み取れません。': 'Cannot read the bundled installer.',
 '導入状態を確認しました。': 'Installation checked.',
 '改行を含むインストール先は使用できません。': 'Installation paths containing newlines are not supported.',
 'インストール先の範囲が不正です。': 'The installation path is outside the allowed range.',
 '補助プログラムとClamAVの接続確認に失敗しました。変更は確定しません。': 'Could not verify communication between the helper and ClamAV. '
                                          'Changes will not be committed.',
 'ClamAVが見つからないか、起動できません。': 'ClamAV was not found or could not be started.',
 'セットアップの識別情報が一致しません。': 'Setup identity does not match.',
 '既に導入済みです。更新／修復を選択してください。': 'Already installed. Choose update or repair.',
 'このセットアップで管理する設置記録がありません。': 'No installation record managed by this setup was found.',
 '通常ファイルではない対象があります: ': 'A target is not a regular file: ',
 '設置記録を確認できません。既存ファイルは変更しません。': 'Cannot verify the installation record. Existing files will not be changed.',
 '導入済みより古いセットアップでは更新できません。': 'An older installer cannot update a newer installation.',
 '確認後に設置状態が変わりました。状態を再確認してください。': 'The installation changed after confirmation. Check its state again.',
 'シンボリックリンクのある設置先は変更しません: ': 'Will not modify an installation path containing a symbolic link: ',
 '既存の登録または起動メニューに変更があります。上書きしません: ': 'The existing registration or launch menu entry has changed. It will '
                                     'not be overwritten: ',
 '別のセットアップが実行中です。': 'Another setup process is running.',
 '処理中に設置状態が変わりました。変更を確定しません。': 'The installation changed during processing. Changes will not be committed.',
 '配布ファイルが不足しています: ': 'Missing distribution file: ',
 '設置済みの配布ファイルに変更があります。ダウンロードしたセットアップから修復してください。': 'Installed distribution files were modified. Repair them '
                                                  'using a downloaded installer.',
 '導入用ファイルの版:': 'Installer version:',
 '補助プログラム:': 'Helper:',
 'メール、ClamAV本体、Thunderbirdの拡張と設定・履歴は変更しません。sudoは不要です。': 'Messages, ClamAV itself, the Thunderbird extension, '
                                                        'settings, and history will not be changed. No sudo '
                                                        'is needed.',
 '実行前に新着メールの自動検査をオフにし、検査を中止して停止を待ってください。補助プログラムはこのOSユーザーで共通です。': 'Turn off automatic scanning of new '
                                                                 'messages, stop scans, and wait for them to '
                                                                 'finish before proceeding. The helper is '
                                                                 'shared by this OS user.',
 '導入用ファイルのサイズが不正です。': 'Invalid installer size.',
 'ClamAV Mail Check 補助プログラムの導入・削除（GUI不要）': 'ClamAV Mail Check helper installation/removal (no GUI required)',
 '表示される変更内容を承認済みとして実行': 'Apply after approving the displayed changes',
 '未導入': 'Not installed',
 '補助プログラムは未導入です。変更はありません。': 'The helper is not installed. No changes were made.',
 '次の場所の管理対象ファイルを': 'Managed files at the following locations will be ',
 'キャンセルしました。変更はありません。': 'Canceled. No changes were made.',
 '補助プログラムの削除が完了しました。': 'Helper removal is complete.',
 '補助プログラムの設置とClamAVの応答確認が完了しました。': 'Helper installation and the ClamAV response check are complete.',
 '変更されたファイルは残しました:': 'Modified files were kept:',
 'アドオンの画面に戻り、': 'Return to the extension and ',
 '通常のユーザーとして実行してください。sudoは不要です。': 'Run as a regular user. No sudo is needed.',
 '導入用ファイルを読み取れません。': 'Cannot read the installer.',
 '管理対象の補助プログラムではありません。CLIで導入し直してください。': 'This is not a managed helper. Reinstall using the command-line '
                                        'installer.',
 'この補助プログラムはアドオンから管理できません。CLIを利用してください。': 'This helper cannot be managed from the extension. Use the '
                                          'command-line installer.',
 '未対応の管理操作です。': 'Unsupported maintenance operation.',
 '管理操作の確認が期限切れか、無効です。': 'The maintenance confirmation is invalid or expired.',
 '削除します。': 'removed.',
 '作成・更新します。': 'created or updated.',
 '拡張の削除を続けてください。': 'continue removing the extension.',
 '「導入を確認」を押してください。': 'click “Confirm installation”.',
 '処理できませんでした:': 'Could not complete the operation:',
 '導入用ファイルの構成が一致しません。': 'The installer contents do not match the expected files.',
 '導入用ファイルの展開サイズが上限を超えています。': 'The unpacked installer exceeds the size limit.',
 '同梱の導入用ファイルが必要です。': 'The bundled installer is required.',
 '導入用ファイルの形式が不正です。': 'Invalid installer format.',
 '実行しますか？ [y/N]: ': 'Proceed? [y/N]: ',
 '未対応の操作です。': 'This operation is not supported.'}


_EN_MESSAGES.update({'ClamAVが見つかりません。先にClamAVを導入してください。Ubuntu / Debianでは次のコマンドを利用できます。': 'ClamAV was not found. Install it first. On Ubuntu / Debian, you can use the following command.', 'ClamAVを確認できませんでした。導入状態を確認してから再実行してください。変更は確定しません。': 'Could not verify ClamAV. Check its installation and try again. Changes will not be committed.'})
def set_language(language):
    global _LANGUAGE
    _LANGUAGE = "ja" if str(language).lower().replace("_", "-").startswith("ja") else "en-US"

def current_language():
    return _LANGUAGE

def tr(message):
    return message if _LANGUAGE == "ja" else _EN_MESSAGES.get(message, message)
