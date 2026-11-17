# ClamAV直接連携の成立性試験

**実験専用です。安定版の置き換えや、普段のメール検査には使用しません。**

ブランチ `experiment/addon-only-clamav` で、Experiment APIからClamAVを直接起動する最小構成を試しています。安定版のソースと別のアドオンIDを使い、実メールを読む権限は持ちません。

自作の補助プログラムの別途導入・Native Messaging登録なしで、Thunderbird 153.7.0esr上の合成メール検査・専用clamdの再利用・更新・削除が動作しました。ただし、現行版の検査範囲の追加判定、異常終了時の処理、検査設定・注意情報・メール操作との統合は未完成です。全面アクセス権限と配布条件の検討も必要です。今回の試作を安定版へ統合する判断はしていません。

## 前提

- 対応確認はUbuntuとThunderbird 153系のみ。対応上限も153系に指定しています。
- インストール済みのClamAVの `clamscan` / `clamd` / `clamdscan` と、OS標準のutil-linuxの `prlimit` / `setpriv` を使用します。
- 新しいパッケージやライブラリは追加していません。
- XPIにはPythonコードを含めず、アドオンからPythonを起動することもありません。検証ランチャーだけがPython標準ライブラリを使います。

## 再現

リポジトリのルートから実行します。

```bash
python3 -B scripts/probe_direct_clamav.py
```

画面を表示しない独立Wayland・D-Bus・XDG設定と、使い捨てThunderbirdプロファイルを使用します。普段のデスクトップ・メール・プロファイルは変更しません。Xwaylandやリモート操作用の権限変更は使わず、Thunderbirdはオフラインで起動します。自動試験はランチャーが専用プロファイルに作ったマーカーがある場合だけ実行します。

Git除外の `dist/direct-clamav-probe/` に結果・診断ログ・実験用XPIを出力します。`result.json` の `ok` は成立性試験の完了を示し、安全な製品への移植完了を示しません。`productionReady` は `false` です。詳細な診断と未解決事項は非公開の作業メモへ記録しています。

## 配布と保守

[Thunderbird公式のExperiment説明](https://developer.thunderbird.net/add-ons/mailextensions/experiments)によると、全面的なアクセス権限となり任意権限は利用できません。導入時の権限表示を実機で確認する作業は未実施です。

2026-11-17に確認した[公式審査ツールの公開ルール](https://github.com/thunderbird/webext-linter/blob/main/assets/registry.yaml)には、公開API草案の未変更コピーを除き、新規のExperiment利用申請を受け付けない旨の記載があります。この独自APIが公式アドオンサイトで公開可能とは判断していません。照会・申請は未実施です。
