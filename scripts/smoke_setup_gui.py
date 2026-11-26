#!/usr/bin/python3
"""Exercise the real GTK UI in a separate headless Wayland/D-Bus session."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = Path(os.environ.get("CLAM_SETUP_GUI_ROOT", str(ROOT)))
sys.path.insert(0, str(APP_ROOT))


def session():
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("GioUnix", "2.0")
    from gi.repository import Gtk, GLib, GioUnix
    from setup import gui

    test_directory = Path(os.environ["CLAM_SETUP_TEST_DIRECTORY"])
    home = test_directory / 'synthetic home %$`"\\'
    home.mkdir()
    state = {"step": 0, "ticks": 0, "error": None}

    def buttons(widget):
        child = widget.get_first_child()
        while child:
            if isinstance(child, Gtk.Button):
                yield child
            yield from buttons(child)
            child = child.get_next_sibling()

    def choose(window, title):
        for dialog in Gtk.Window.list_toplevels():
            if dialog == window:
                continue
            for button in buttons(dialog):
                if button.get_label() == title:
                    button.emit("clicked")
                    return True
        return False

    def tick():
        state["ticks"] += 1
        app = Gtk.Application.get_default()
        window = next((item for item in app.get_windows() if hasattr(item, "manager")), None) if app else None
        try:
            if state["ticks"] > 300:
                raise AssertionError("GUI test timed out at step " + str(state["step"]))
            if not window or window.busy:
                return True
            step = state["step"]
            if step == 0:
                assert not list(home.rglob("*")), "Opening setup must be read-only"
                assert window.get_width() > 0 and window.get_height() > 0
                window.kind.set_selected(2)
                assert not window.buttons["install"].get_sensitive()
                window.kind.set_selected(1)
                assert window.buttons["install"].get_sensitive()
                window.buttons["install"].emit("clicked")
                state["step"] = 1
            elif step == 1:
                if choose(window, "キャンセル"):
                    state["step"] = 2
            elif step == 2:
                assert not window.manager.layout.receipt.exists()
                window.buttons["install"].emit("clicked")
                state["step"] = 3
            elif step == 3:
                if choose(window, "インストール"):
                    state["step"] = 4
            elif step == 4:
                assert window.manager.state()["healthy"], window.result.get_text()
                paintable = Gtk.WidgetPaintable.new(window)
                snapshot = Gtk.Snapshot.new()
                paintable.snapshot(snapshot, window.get_width(), window.get_height())
                node = snapshot.to_node()
                texture = window.get_renderer().render_texture(node, None)
                (ROOT / ".codex-private/test-output").mkdir(parents=True, exist_ok=True)
                assert texture.save_to_png(str(ROOT / ".codex-private/test-output/setup-gui.png"))
                desktop = GioUnix.DesktopAppInfo.new_from_filename(str(window.manager.layout.desktop))
                assert desktop is not None
                assert "/usr/bin/python3" in desktop.get_commandline()
                state["release"] = window.manager.receipt()["release"]
                # Execute a harmless replacement only in the disposable fixture
                # to verify Desktop Entry argument escaping, including %, quotes
                # and backslashes. No real GUI/profile is started by this child.
                installed = window.manager.layout.base / state["release"]
                (installed / "setup.py").write_text(
                    "from pathlib import Path\nPath(__file__).with_name('desktop-launched').write_text('ok')\n"
                )
                desktop.launch([], None)
                state["step"] = 9
            elif step == 9:
                installed = window.manager.layout.base / state["release"]
                if not (installed / "desktop-launched").exists():
                    return True
                window.buttons["repair"].emit("clicked")
                state["step"] = 5
            elif step == 5:
                if choose(window, "更新／修復"):
                    state["step"] = 6
            elif step == 6:
                assert window.manager.state()["healthy"], window.result.get_text()
                assert window.manager.receipt()["release"] != state["release"]
                window.buttons["uninstall"].emit("clicked")
                state["step"] = 7
            elif step == 7:
                if choose(window, "アンインストール"):
                    state["step"] = 8
            elif step == 8:
                assert window.finished, window.result.get_text()
                assert not window.manager.layout.registration.exists()
                assert not window.manager.layout.desktop.exists()
                assert not window.manager.layout.receipt.exists()
                print("GTK setup smoke: passed (cancel, install, repair, uninstall, Snap guard, desktop entry)", flush=True)
                app.quit()
                return False
        except Exception as error:
            state["error"] = error
            if app:
                app.quit()
            return False
        return True

    GLib.timeout_add(100, tick)
    with patch("setup.gui.Path.home", return_value=home):
        result = gui.main()
    if state["error"]:
        raise state["error"]
    assert state["step"] == 8
    return result


def main():
    if "--session" in sys.argv:
        return session()
    with tempfile.TemporaryDirectory(prefix="clam-setup-wayland-") as temporary:
        directory = Path(temporary)
        runtime = directory / "runtime"
        runtime.mkdir(mode=0o700)
        bus_config = directory / "session-bus.conf"
        bus_config.write_text('''<busconfig>
<type>session</type><listen>unix:tmpdir=/tmp</listen>
<policy context="default"><allow send_destination="*"/>
<allow receive_sender="*"/><allow own="*"/></policy>
</busconfig>''')
        env = {**os.environ, "XDG_RUNTIME_DIR": str(runtime), "DISPLAY": "",
               "WAYLAND_DISPLAY": "clam-setup-test", "GDK_BACKEND": "wayland",
               "GSK_RENDERER": "cairo", "GSETTINGS_BACKEND": "memory",
               "XDG_CONFIG_HOME": str(directory / "config"),
               "XDG_CACHE_HOME": str(directory / "cache"),
               "XDG_DATA_HOME": str(directory / "data"),
               "CLAM_SETUP_TEST_DIRECTORY": temporary, "GTK_A11Y": "none",
               "GTK_USE_PORTAL": "0", "GIO_USE_VFS": "local"}
        if "--bundle" in sys.argv:
            env["CLAM_SETUP_GUI_ROOT"] = str(Path(sys.argv[sys.argv.index("--bundle") + 1]).resolve())
        command = ["/usr/bin/weston", "--backend=headless", "--renderer=pixman",
                   "--shell=kiosk-shell.so", "--no-config", "--idle-time=0",
                   "--width=1000", "--height=1000", "--socket=clam-setup-test",
                   "--log=" + str(directory / "weston.log")]
        compositor = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if (runtime / "clam-setup-test").exists():
                    break
                if compositor.poll() is not None:
                    log = directory / "weston.log"
                    raise RuntimeError(compositor.stderr.read().decode() +
                                       (log.read_text() if log.exists() else ""))
                time.sleep(0.05)
            else:
                raise RuntimeError("Independent Wayland session did not start")
            result = subprocess.run(["/usr/bin/dbus-run-session", "--config-file=" + str(bus_config), "--", sys.executable,
                                     "-B", str(Path(__file__).resolve()), "--session"],
                                    env=env, timeout=45, check=False)
            return result.returncode
        finally:
            compositor.terminate()
            compositor.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
