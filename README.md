# ClamAV Mail Check / ClamAV メール検査

Thunderbirdのメールを、コンピューターにインストールしたClamAVで検査する拡張機能です。
現在の配布版は **0.20.0a5（試用版）** です。補助プログラムの別途インストールは不要です。

## インストール

1. [Releases](https://github.com/jidaikobo-shibata/thunderbird-clamav/releases)から、`clam-mail-check-direct-0.20.0a5.xpi`をダウンロードします。「Source code」のZIPではありません。
2. Thunderbirdのアドオンマネージャーで、歯車メニューの「ファイルからアドオンをインストール」を選び、XPIを指定します。
3. 表示される権限を確認してインストールします。Experiment APIを使用するため、Thunderbirdとコンピューターへの全面アクセス権限が必要です。
4. ツールバーのアイコンから画面を開き、「設定」末尾の「ClamAVの状態」で「接続を再確認」を押します。ClamAVが未導入なら、表示される導入手順に従います。ウイルス定義の初回更新も完了させてください。
5. 「検査」で少量のフォルダーを検査します。結果を確認してから、「設定」で新着メールを自動検査するアカウントを選びます。初期状態では自動検査はオフです。

### 確認済みの環境

- Ubuntu、通常パッケージ版のThunderbird **153系**。153.7.0esr（64ビット）で検証しています。
- Python 3.10以降（`/usr/bin/python3`）。
- ClamAV（`/usr/bin/clamscan`）と更新済みの定義。高速な連続検査には`/usr/sbin/clamd`も使います。
- Snap・Flatpak版、Windows・macOS、Thunderbirdの他のメジャーバージョンは未検証です。XPIの対応範囲は153系に限定しています。

ClamAVは別途必要です。Ubuntu / Debian向けの導入例は次のとおりです。OSのパッケージを変更する操作です。

```bash
sudo apt install clamav clamav-daemon clamav-freshclam
```

[ClamAV公式の導入ガイド](https://docs.clamav.net/manual/Installing/Packages.html)

## できること

- 選択したアカウントの新着メールの自動検査。
- 絞り込みと複数選択によるフォルダーの一括検査、進捗表示、中止・再開。
- 検査結果の検索・絞り込み・ページをまたぐ選択・再検査・履歴だけの消去。
- 検出メールの隔離先への移動と、確認操作を伴う完全削除。自動完全削除はありません。
- 暗号化などの未検査部分、検査失敗、注意情報を未検出と区別。「確認済み」と判断メモも記録できます。
- フィッシング・マクロ・PUAの扱い、サイズと時間の上限設定。
- 日本語と英語の画面表示。

ClamAVが検出しないメールの安全性を保証するものではありません。暗号化・検査上限・通信失敗などは結果に表示します。

## 更新と削除

更新は、新しいXPIを**旧版を削除せず上書きインストール**します。設定と履歴を引き継ぎます。GitHubの新しい試用版を確認して手動で更新してください。

削除はThunderbirdのアドオンマネージャーから行います。メールとClamAV・Python3は残ります。アドオンの通常の設定と履歴は失われる可能性があります。

## データの扱い

メール本文と添付ファイルをローカルの検査処理へ渡します。検査のための一時ファイルは終了時に削除します。メール本文や検査結果を外部サービスへ送信する機能、利用状況の収集はありません。ClamAVの定義更新は、別途導入したFreshClamが担当します。

差出人・件名・検出名・判断メモなどはThunderbirdのローカルストレージに保存します。本文と添付は履歴に保存しません。既存データの初回移行時には、プロファイル内にバックアップを保存します。このバックアップはアドオンを削除しても残り、自動復元・自動消去はしません。

## 不具合の報告

[Issues](https://github.com/jidaikobo-shibata/thunderbird-clamav/issues)へ、OS・Thunderbird・アドオン・ClamAVのバージョン、操作手順、表示されたエラーを記載してください。

公開のIssueに実際のメール本文・添付・差出人・件名・メールアドレス・プロファイルの内容を貼らないでください。再現に必要なら、内容を置き換えた合成データを使ってください。

## 開発

追加のPythonパッケージやnpmパッケージのインストールは不要です。

```bash
python3 -B scripts/build_direct_mail_check.py
```

成果物は`dist/clam-mail-check-direct-0.20.0a5.xpi`です。JavaScriptのテストにはNode.js 22以降を使います。

```bash
for test_file in tests/*.test.mjs; do
  node "$test_file" || break
done
python3 -B -m unittest discover -s tests
```

[内蔵方式の設計と検証](experiments/direct-runtime/README.md) / [旧Native Messaging方式の記録](README-legacy.md)

## ライセンス

[MIT](LICENSE)。ClamAVやThunderbird自体は同梱しておらず、それぞれのライセンスに従います。
