# ClamAV Mail Check

受信メールをローカルのClamAVで1通ずつ検査するThunderbird拡張です。
定期検査用のclamリポジトリから分離して、独立したGitリポジトリで管理します。
既存の定期検査スクリプト・cron・ClamAVサービス設定は変更しません。

## 初期版の機能

- 指定アカウントの新着メールを順に検査。自動検査は初期状態では無効。
- メール一覧の右クリック、または結果画面から選択メールを手動検査。
- 差出人・件名・検査日時・定義バージョン・検出名・失敗理由を表示。
- 検出・検査不能・失敗をデスクトップ通知。通知に差出人・件名は含めない。
- 結果から対象メールをThunderbirdのタブで開き、標準操作で移動・削除できる。
- 再検査、完了した検査履歴の消去。

拡張にメールの変更・移動・削除・送信権限はありません。
検査結果があるメールの自動隔離や自動削除も行いません。
本文を開く操作ではHTMLが表示され得るため、検出メールは確認を挟みます。

## 対応環境と必要なもの

- Ubuntu / Linux。対象実機バージョンはThunderbird 153.7.0esr（64ビット）。
- マニフェストの最低バージョンはThunderbird 140。ただし140での実機検証は未実施。
- Python 3.10以降、`/usr/bin/python3`。
- `/usr/bin/clamscan` と更新済みのClamAV定義。1.5.4でローカル検査を確認。
- ビルドはPython標準ライブラリのみ。JavaScriptのテストにはNode.js 22以降。

Snap・Flatpak版のNative Messaging連携は未検証です。
サンドボックスの権限を広げる設定を自動で追加することはありません。
Thunderbirdでの実機読み込み、受信イベント、IMAP移動後の再特定は検証待ちです。

## 構成

`thunderbird/` がMailExtension、`native/host.py` がNative Messaging用の
補助プログラムです。依存パッケージや常駐HTTPサーバーは不要です。
拡張から64KiB以下のデータ片を順に渡し、補助プログラムはSHA-256で
一致を確認してからClamAVを実行します。

初期版では、メールごとに`clamscan`を標準入力で起動します。
検査上限・暗号化の警告を呼び出し時に指定でき、既存の`clamd`設定や
ソケット権限を変更せずに検査不能を判別するためです。
小さなテストメールで1通約4.7秒を要しました。大量受信時には待ち時間が増えます。
設定を確認した`clamd`による高速化は今後の課題です。

メールデータをClamAVに渡す際、シェルを使いません。
補助プログラムには任意のコマンド・ファイルパスを受け付ける機能がありません。
Thunderbird標準の「ウイルス対策ソフトが受信メールを個別に隔離できるようにする」
設定、および`clamonacc`は使いません。

## ビルドとテスト

リポジトリのルートで実行します。

```bash
python3 -m unittest discover -s tests -v
node tests/mail_core.test.mjs
node tests/mail_background.test.mjs
node --check thunderbird/background.js
node --check thunderbird/dashboard.js
python3 scripts/build_mail_check.py
```

`dist/clam-mail-check-0.1.0.xpi` と、確認用の補助プログラム・登録JSONを
`dist/native/` に生成します。生成しただけではインストールされません。

実際のClamAVとの接続確認は次のコマンドで実施できます。
通常メール・EICARの添付・ZIP内EICAR・暗号化メールをメモリ内で生成します。
メールアカウント・ネットワーク・普段のThunderbirdプロファイルは使いません。
ClamAV内部の展開用一時ファイルは、所有者だけが読める一時ディレクトリで扱い、
正常終了・例外・タイムアウト時に後始末します。

```bash
python3 scripts/smoke_mail_check.py
```

画面の操作・文字列の安全な表示・狭い画面でのレイアウトは、別プロファイルの
ヘッドレスChromeで確認できます。実行にはGoogle Chromeが必要です。
ローカル専用HTTPサーバーには画面のアセットと架空のデータだけを渡します。

```bash
node scripts/smoke_mail_ui.mjs
```

## 補助プログラムの登録

**ここからはユーザー環境への導入です。対象を確認してから実行してください。**

まず次のコマンドで、作成先の絶対パスを表示します。確認のみで変更しません。

```bash
python3 scripts/register_mail_host.py
```

登録を実施する場合だけ、次を実行します。

```bash
python3 scripts/register_mail_host.py --install
```

ユーザーのホーム配下に、次の2ファイルを新規作成します。

```text
$HOME/.local/lib/clam-mail-check/0.1.0/host.py
$HOME/.mozilla/native-messaging-hosts/local.clam_mail_check.json
```

補助プログラムの許可対象は、この拡張の固定ID
`clam-mail-check@local.invalid`だけです。root・sudoは不要です。
既存のファイルやシンボリックリンクがある場合は上書きせずに終了します。
アップデート・アンインストールはまだ自動化していません。

## Thunderbirdへの読み込み

1. 実機検証ではまず別のテスト用プロファイルを使います。
2. 「アドオンとテーマ」からアドオンのデバッグ画面を開きます。
3. 「一時的なアドオンを読み込む」で、ビルドしたXPIまたは
   `thunderbird/manifest.json`を指定します。
4. メール検査のボタンから結果画面を開き、ClamAVとの接続を確認します。
5. 架空のテストメールを選択し、右クリックから手動検査します。
6. 問題がなければ対象アカウントを選び、自動検査を有効にして設定を保存します。

一時的な読み込みはThunderbirdの再起動で解除されます。
通常のXPIインストールは、そのビルドの署名ポリシーに従います。
署名確認やセキュリティ設定を変更する手順は含めません。

## 状態と制限

| 状態 | 意味 |
|---|---|
| 検査待ち / 検査中 | まだ結果は出ていません |
| 未検出 | 指定範囲で脅威を検出しませんでした。安全の保証ではありません |
| 脅威候補を検出 | 検出名を表示します。誤検知の可能性もあるため人が判断します |
| 一部または全部が未検査 | 暗号化、サイズ・展開上限、ClamAVの警告など |
| 検査失敗 | 未導入、通信失敗、取得失敗、定義が古い、タイムアウトなど |

- 検査は受信後です。本文表示や添付ファイルを開く操作を止めません。
- 1通25MiB、展開後合計100MiB、展開ファイル数10000、再帰16段が上限。
- エンジン検査は60秒、定義読み込み等を含むプロセス全体は120秒が上限。
- 定義が3日超古い場合、`clamscan`の機能で検査を失敗として扱います。
- URLの評判によるフィッシング判定は、既存のメール検査運用に合わせて無効。
  HTMLや添付に対する通常のマルウェア検査は実行します。
- OpenPGP・S/MIMEメールは復号しません。暗号化部分は検査不能として表示。
- IMAPの本文取得に追加の通信が生じる場合があります。ヘッダーのみのメールは
  本文をダウンロードしてから再検査してください。
- 検査失敗は60秒後に1回再試行します。自動検査を止めると自動分の再開も止まります。
  実行中の1通は完了まで進めます。手動検査は自動検査の設定に依存しません。
- 新着の対象はThunderbirdの受信イベントです。過去メール全体や拡張停止中の
  受信を網羅する追跡機能はありません。必要なメールは手動検査してください。

## 履歴と対象メールの特定

履歴はThunderbirdの拡張専用ローカル保存領域に最大1000件保持します。
差出人・件名・アカウント/フォルダー識別情報・日時・メール全体のSHA-256・
検査結果を保存します。本文と添付は履歴に保存しません。
OSのユーザー権限で読める情報であり、履歴自体の暗号化は行いません。

上限では古い未検出結果から置き換えます。未検出以外で満杯の場合は新規受付を
停止し、結果画面とバッジで通知します。確認後に履歴を消去してください。
表示はフィルターに該当する最新100件です。期間での自動削除はありません。

Thunderbird内部の数値IDは再起動後に再利用しません。
再起動・移動後はMessage-ID、アカウント、差出人、件名、日時、必要に応じて
SHA-256を照合します。複数候補・Message-IDなし・消失したメールは推測で開かず、
メール一覧から選択して再検査するよう案内します。
添付の削除やヘッダー変更などで内容が変わった場合も再検査が必要です。

## 実機での受け入れ確認

- 正常メール、EICAR添付、ZIP添付、暗号化、サイズ超過の状態表示。
- フィルターで受信トレイ以外へ移動するメール、迷惑メールフォルダーの受信。
- 複数アカウント、100件を超える一括受信、オフライン後の手動再検査。
- 検査中の再起動と、メール移動・削除・同じMessage-IDの複数コピー。
- ClamAVの停止・未導入・古い定義・タイムアウト・デスクトップ通知失敗。
- キーボード操作、読み上げ、拡大表示。色だけでは状態を区別しません。
- 通常のメール操作への負荷。`clamscan`方式は大量受信で待ち時間が増えます。

## 公式資料

- [Thunderbird messages API](https://webextension-api.thunderbird.net/en/esr-mv2/messages.html)
- [Thunderbird runtime API](https://webextension-api.thunderbird.net/en/esr-mv2/runtime.html)
- [Mozilla Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Mozilla Native manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests)
- [ClamAV Scanning](https://docs.clamav.net/manual/Usage/Scanning.html)
