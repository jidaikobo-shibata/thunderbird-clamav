"""GTK4 setup UI. All mutations require a modal confirmation."""

from pathlib import Path
import os
import subprocess
import sys
import threading

from .manager import EXTENSION, Manager, SetupError, environment


def main():
    if os.getuid() == 0:
        print("このセットアップは通常のユーザーとして実行してください。sudoは不要です。", file=sys.stderr)
        return 1
    try:
        import gi
        gi.require_version("Gtk", "4.0")
        from gi.repository import Gtk, Gio, GLib
        if Gtk.get_minor_version() < 10:
            raise ImportError("GTK 4.10以降が必要です。")
    except (ImportError, ValueError) as error:
        message = "セットアップにはPythonのGTK 4連携とGTK 4.10以降が必要です。\n" + str(error)
        try:
            subprocess.run(["/usr/bin/zenity", "--error", "--text=" + message], check=False)
        except OSError:
            print(message, file=sys.stderr)
        return 1

    class SetupWindow(Gtk.ApplicationWindow):
        def __init__(self, application):
            super().__init__(application=application, title="ClamAV Mail Check セットアップ")
            self.set_default_size(760, 720)
            self.busy = False
            self.finished = False
            self.info = {}
            self.state = {}
            self.manager = Manager(Path(__file__).resolve().parents[1], Path.home())
            self.connect("close-request", lambda window: self.busy)
            scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
            self.set_child(scroll)
            content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18,
                              margin_top=24, margin_bottom=24, margin_start=24, margin_end=24)
            scroll.set_child(content)
            self.label(content, "ClamAV Mail Check", heading=True)
            self.label(content, "メール検査に必要な補助プログラムを、このユーザー専用に導入します。管理者権限は不要です。")
            self.status = self.label(content, "状態を確認しています。")
            self.engine = self.label(content, "")
            self.label(content, "Thunderbirdの導入方法")
            self.kind = Gtk.DropDown.new_from_strings([
                "分からない／未確認", "通常版（公式配布版・deb等）", "Snap版", "Flatpak版"
            ])
            self.kind.update_property([Gtk.AccessibleProperty.LABEL], ["Thunderbirdの導入方法"])
            self.kind.connect("notify::selected", lambda *args: self.controls())
            content.append(self.kind)
            self.kind_note = self.label(content, "")
            self.label(content, "補助プログラムの導入後、Thunderbirdの「アドオンとテーマ」から同梱のXPIを読み込みます。自動検査は初期状態ではオフです。")

            actions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
            content.append(actions)
            self.buttons = {}
            for operation, title in [("install", "インストール"), ("repair", "更新／修復"),
                                     ("uninstall", "アンインストール")]:
                button = Gtk.Button(label=title)
                button.connect("clicked", lambda button, op=operation: self.confirm(op))
                self.buttons[operation] = button
                actions.append(button)
            self.refresh_button = Gtk.Button(label="状態を再確認")
            self.refresh_button.connect("clicked", lambda button: self.refresh())
            actions.append(self.refresh_button)
            self.open_button = Gtk.Button(label="同梱XPIのあるフォルダーを開く")
            self.open_button.connect("clicked", lambda button: self.open_folder())
            actions.append(self.open_button)
            self.spinner = Gtk.Spinner()
            content.append(self.spinner)
            self.result = self.label(content, "")
            self.result.set_selectable(True)
            self.label(content, "更新と削除は、このセットアップの設置記録と一致するファイルだけを対象にします。ClamAV本体、メール、拡張の検査履歴は削除しません。")
            details = Gtk.Expander(label="設置先と許可の詳細")
            self.details = Gtk.Label(wrap=True, xalign=0, selectable=True)
            details.set_child(self.details)
            content.append(details)
            self.details.set_text("\n".join([
                "補助プログラム・設置記録: " + str(self.manager.layout.base),
                "Thunderbirdとの接続登録: " + str(self.manager.layout.registration),
                "アプリ一覧の起動項目: " + str(self.manager.layout.desktop),
                "許可する拡張: " + EXTENSION,
                "設定・メール・ClamAVサービスの変更はありません。"
            ]))
            self.close_button = Gtk.Button(label="閉じる")
            self.close_button.connect("clicked", lambda button: self.close())
            content.append(self.close_button)
            self.refresh()

        def label(self, box, text, heading=False):
            label = Gtk.Label(label=text, wrap=True, xalign=0)
            if heading:
                label.add_css_class("title-1")
            box.append(label)
            return label

        def controls(self):
            installed = self.state.get("installed", False)
            supported = self.kind.get_selected() == 1
            ready = not self.busy and not self.finished
            available = ready and supported and self.info.get("clam", False) and not self.state.get("conflict")
            self.buttons["install"].set_sensitive(bool(available and not installed))
            self.buttons["repair"].set_sensitive(bool(available and installed))
            self.buttons["uninstall"].set_sensitive(bool(ready and installed and not self.state.get("conflict")))
            self.refresh_button.set_sensitive(ready)
            self.kind.set_sensitive(ready)
            self.close_button.set_sensitive(not self.busy)
            self.open_button.set_sensitive(ready)
            note = ("通常版を対象に登録します。" if supported else
                    "導入方法を確認して選択してください。バージョン番号だけでは判別できません。" if self.kind.get_selected() == 0 else
                    "Snap・Flatpak版の連携は未検証です。このセットアップでは新規導入・更新を行いません。")
            if self.info and not self.info.get("clam"):
                note += " ClamAVをOSのパッケージ管理から別途導入し、「状態を再確認」を押してください。"
            self.kind_note.set_text(note)

        def worker(self, callback, done):
            self.busy = True
            self.spinner.start()
            self.controls()

            def run():
                try:
                    value, error = callback(), None
                except Exception as exc:
                    value, error = None, str(exc)

                def finish():
                    self.busy = False
                    self.spinner.stop()
                    done(value, error)
                    self.controls()
                    return False
                GLib.idle_add(finish)
            threading.Thread(target=run, daemon=True).start()

        def refresh(self):
            if self.busy or self.finished:
                return

            def check():
                info = environment()
                try:
                    state = self.manager.state()
                except (OSError, SetupError) as error:
                    state = {"conflict": str(error)}
                return info, state

            def done(value, error):
                if error:
                    self.result.set_text(error)
                    return
                first = not self.info
                self.info, self.state = value
                self.engine.set_text(self.info["engine"])
                if first:
                    self.kind.set_selected({"normal": 1, "snap": 2, "flatpak": 3}.get(self.info["kind"], 0))
                text = ("既存の設置を安全に確認できません。\n" + self.state["conflict"] if self.state.get("conflict") else
                        "補助プログラム: 未導入" if not self.state["installed"] else
                        "補助プログラム: " + self.state["version"] +
                        ("（設置ファイルは一致しています）" if self.state["healthy"] else "（修復が必要です）"))
                self.status.set_text(text)
            self.worker(check, done)

        def confirm(self, operation):
            if self.busy:
                return
            try:
                plan = self.manager.plan(operation)
            except (OSError, SetupError) as error:
                self.result.set_text(str(error))
                return
            titles = {"install": "インストール", "repair": "更新／修復", "uninstall": "アンインストール"}
            verb = titles[operation]
            detail = ("次の場所にある、このセットアップが管理するファイルを" +
                      ("削除します。" if operation == "uninstall" else "作成・更新します。") +
                      "\n\n" + "\n".join(plan["paths"]) +
                      "\n\nこの拡張からローカルの検査プログラムを起動できるようにします。" +
                      "\nClamAV本体・メール・検査履歴は変更しません。")
            if operation == "uninstall":
                detail = detail.replace("この拡張からローカルの検査プログラムを起動できるようにします。",
                                        "削除後は、この拡張からの検査ができなくなります。")
            dialog = Gtk.AlertDialog(message=verb + "を実行しますか？", detail=detail,
                                     buttons=["キャンセル", verb], cancel_button=0, default_button=0)

            def response(dialog, result):
                try:
                    choice = dialog.choose_finish(result)
                except GLib.Error:
                    return
                if choice == 1:
                    self.execute(operation, plan["token"])
            dialog.choose(self, None, response)

        def execute(self, operation, token):
            self.result.set_text("処理しています。完了まで画面を閉じずにお待ちください。")

            def done(value, error):
                if error:
                    self.result.set_text("処理を完了できませんでした。\n" + error)
                    self.refresh()
                    return
                text = "アンインストールが完了しました。この画面を閉じてください。" if operation == "uninstall" else (
                    "導入が完了しました。補助プログラムとClamAVの通信を確認しました。\n"
                    "ThunderbirdにXPIを読み込み、拡張の画面から接続を確認してください。\n"
                    "今後はアプリ一覧の「ClamAV Mail Check セットアップ」から管理できます。")
                if value["retained"]:
                    text += "\n変更されたファイルなどは削除せず残しました:\n" + "\n".join(value["retained"])
                self.result.set_text(text)
                if operation == "uninstall":
                    self.finished = True
                else:
                    self.refresh()
            self.worker(lambda: self.manager.apply(operation, token), done)

        def open_folder(self):
            root = self.manager.root
            folder = root if (root / "extension.xpi").exists() else root / "dist"
            try:
                Gio.AppInfo.launch_default_for_uri(folder.as_uri(), self.get_display().get_app_launch_context())
            except GLib.Error as error:
                self.result.set_text("フォルダーを開けませんでした。\n" + str(folder) + "\n" + str(error))

    application = Gtk.Application(application_id="local.clam_mail_check.Setup")

    def activate(app):
        window = app.get_active_window()
        if window is None:
            try:
                window = SetupWindow(app)
            except (OSError, ValueError, SetupError) as error:
                dialog = Gtk.AlertDialog(message="セットアップを開始できません。", detail=str(error))
                dialog.show(None)
                return
        window.present()
    application.connect("activate", activate)
    return application.run([sys.argv[0]])
