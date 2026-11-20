# ClamAV Mail Check / ClamAV メール検査

Thunderbirdのメールを、コンピューターにインストールしたClamAVで検査する拡張機能です。
このブランチは **0.20.0a22（試用版）** です。補助プログラムの別途インストールは不要です。
公開済みの0.20.0a5はUbuntu向けです。このブランチのXPIは末尾のビルド手順で作成できます。GitHubにはまだ公開していません。

[English installation guide](README.en.md)

## インストール

1. このブランチから作成した`dist/clam-mail-check-direct-0.20.0a22.xpi`を用意します。公開済みのUbuntu向け試用版は[Releases](https://github.com/jidaikobo-shibata/thunderbird-clamav/releases)にあります。「Source code」のZIPではありません。
2. Thunderbirdのアドオンマネージャーで、歯車メニューの「ファイルからアドオンをインストール」を選び、XPIを指定します。
3. 表示される権限を確認してインストールします。Experiment APIを使用するため、Thunderbirdとコンピューターへの全面アクセス権限が必要です。
4. ツールバーのアイコンから画面を開き、「設定」末尾の「ClamAVの状態」で「接続を再確認」を押します。ClamAVが未導入なら、表示される導入手順に従います。ウイルス定義の初回更新も完了させてください。
5. 「検査」で少量のフォルダーを検査します。結果を確認してから、「設定」で新着メールを自動検査するアカウントを選びます。初期状態では自動検査はオフです。

### 確認済みの環境

- Ubuntu、通常パッケージ版のThunderbird **153系**。153.7.0esr（64ビット）で検証しています。
- macOS 15.6.1、Apple Silicon（arm64）、Thunderbird 153.5.1esr。macOSでの最新の確認結果・未確認事項は[検証記録](experiments/direct-runtime/README.md)を参照してください。
- Python 3.10以降。Ubuntuは`/usr/bin/python3`、macOSはHomebrew版またはpython.org版を使用します。macOS付属の古いPythonや開発ツール導入用の起動ファイルは使用しません。
- ClamAVと更新済みの定義。Ubuntuは`/usr/bin/clamscan`・`/usr/sbin/clamd`、macOSはHomebrew版を使用します。
- 0.20.0a7は利用者からUbuntu・Apple Silicon Mac双方で動作良好との報告がありました。
- Intel Macは実機未検証で、今後確認予定です。Windowsは現在未対応で、今後対応を進める予定です。
- Snap・Flatpak版、Thunderbirdの他のメジャーバージョンは未検証です。XPIの対応範囲は153系に限定しています。

ClamAVは別途必要です。Ubuntu / Debian向けの導入例は次のとおりです。OSのパッケージを変更する操作です。

```bash
sudo apt install clamav clamav-daemon clamav-freshclam
```

[ClamAV公式の導入ガイド](https://docs.clamav.net/manual/Installing/Packages.html)

### macOSの準備

Homebrewが導入済みなら、次を実行します。パッケージと必要な依存を追加する操作です。python.org版のPython 3.10以降が既にある場合、`python`の追加は不要です。

```bash
brew install clamav python
```

定義の保存先はApple Siliconでは`/opt/homebrew/var/lib/clamav`、Intelでは`/usr/local/var/lib/clamav`です。画面の「設定」末尾にCPUに応じたコマンドを表示します。Apple Siliconで、既存のFreshClam設定がない場合の例です。設定ファイルが既にある場合は作成を拒否するので、既存の内容を確認してください。

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

FreshClamは公式ミラーから定義を取得します。初回更新が成功してから「接続を再確認」を押し、少量のメールで試します。定義は同じFreshClamコマンドで定期的に更新してください。3日より古い定義では検査を完了しません。この拡張は定義の自動更新を設定しません。

`brew services`による常駐サービスの登録やNative Messagingの登録は不要です。必要時だけアドオン専用の検査プロセスを起動します。署名検証やGatekeeper等の無効化、フルディスクアクセスの追加は導入手順に含めません。

Homebrewの標準配置（Apple Siliconの`/opt/homebrew`、Intelの`/usr/local`）とpython.orgの`/Library/Frameworks/Python.framework/Versions/Current/bin/python3`を探索します。PATH、メール、画面から任意の実行ファイルやオプションは指定できません。リンク先と所有者・権限を検査し、PythonとClamAVの版を確認します。独自プレフィックス、MacPorts、ClamXAV同梱版はこの版の対象外です。既存の他製品やサービスは変更しません。

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

0.20.0a13では履歴と再開用データの保存形式を変更しています。既存データがある場合は移行前にプロファイル内へバックアップを作成し、作成できなければ移行を停止します。0.20.0a12以前への上書きによるダウングレードは対応していません。戻す場合は、移行前バックアップからの復元が必要です。

削除はThunderbirdのアドオンマネージャーから行います。メールとClamAV・Python3は残ります。アドオンの通常の設定と履歴は失われる可能性があります。

## メールを移動した場合

通常のフォルダー移動でも、移動イベントと本文の照合によって既存の履歴の場所を更新します。検査結果と確認メモは保持し、移動先で再び新着扱いの通知を受けても、更新済みの同じメールを別の履歴として追加しません。検査中の移動では古い場所の情報で上書きしないようにします。本文を確認できない場合や候補が複数ある場合は、自動では引き継ぎません。コピーしたメールは別件として扱います。

以前の版で既にできた重複履歴は、自動削除・統合しません。

## 起動時の保存エラーからの復旧

初期化に失敗した場合は、保存先の空き容量やアクセス状態を確認してから、設定末尾の「接続を再確認」で再試行できます。復旧するまで検査と設定変更は行いません。新しいフォルダー検査の開始状態を保存できなかった場合も、以前の検査の進捗と再開情報を保持します。

新着の受付を保存できなかった場合は、失敗したメールと未受付分をメモリ上に保持し、10秒ごとに再試行します。後続の新着や手動検査は続行できます。保留中の案内が解消するまでThunderbirdを終了しないでください。保存の復旧前に終了した場合、未保存の受付は復元できません。

## データの扱い

内蔵の検査接続は、短い間隔の新着などで再利用するため、通常5秒間待機してから閉じます。待機中はClamAVの定義などのメモリと一時ディレクトリを保持します。

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

成果物は`dist/clam-mail-check-direct-0.20.0a22.xpi`です。同じXPIにUbuntu/macOS用の処理を含みます。JavaScriptのテストにはNode.js 22以降を使います。

```bash
for test_file in tests/*.test.mjs; do
  node "$test_file" || break
done
python3 -B -m unittest discover -s tests
```

[内蔵方式の設計と検証](experiments/direct-runtime/README.md) / [旧Native Messaging方式の記録](README-legacy.md)

## ライセンス

[MIT](LICENSE)。ClamAVやThunderbird自体は同梱しておらず、それぞれのライセンスに従います。
