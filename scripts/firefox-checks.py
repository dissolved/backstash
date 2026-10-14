# /// script
# requires-python = ">=3.11"
# dependencies = ["marionette-driver==3.7.1"]
# ///
"""Real Firefox checks in an owned disposable profile; run with uv run."""

import argparse
import json
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import socket
import tempfile
from threading import Thread
import time
import zipfile

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

ROOT = Path(__file__).resolve().parent.parent
ADDON_ID = "backstash@codedissolved.com"


def package(destination):
    # Explicit allowlist: never package repository metadata, credentials or profiles.
    manifest = json.loads((ROOT / "manifest.json").read_text())
    names = ["manifest.json", "stash-popup.html", "stash-popup.css", "stash-popup.js"]
    names += manifest["background"]["scripts"]
    names += manifest.get("icons", {}).values()
    names += manifest.get("action", {}).get("default_icon", {}).values()
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in dict.fromkeys(names):
            archive.write(ROOT / name, name)
        archive.write(ROOT / "tests/firefox/scenarios.js", "integration/scenarios.js")


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def chrome(driver, script, args=()):
    with driver.using_context("chrome"):
        return driver.execute_script(script, script_args=args)


def extension_script(driver, body, args=(), timeout=30000):
    result = driver.execute_async_script(
        "const done = arguments[arguments.length - 1];"
        "(async () => {" + body + "})().then(value => done({ok:true,value}),"
        "error => done({ok:false,error:String(error),stack:error.stack}));",
        script_args=args, sandbox=None, script_timeout=timeout,
    )
    if not result["ok"]:
        raise AssertionError(result["error"] + "\n" + result.get("stack", ""))
    return result.get("value")


def wait_for(check, message, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError("Timed out: " + message)


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f'<!doctype html><title>{escape(self.path)}</title><p>Local test tab.</p>'.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def open_controller(driver):
    wait_for(lambda: chrome(driver, "return !!WebExtensionPolicy.getByID(arguments[0]);", [ADDON_ID]), 'extension loaded')
    base = chrome(driver, "return WebExtensionPolicy.getByID(arguments[0]).getURL('');", [ADDON_ID])
    driver.switch_to_window(driver.window_handles[0])
    handle = driver.open(type='tab')
    driver.switch_to_window(handle['handle'])
    driver.navigate(base + 'stash-popup.html')
    extension_script(driver, "await browser.runtime.sendMessage({type:'list-stashes'});")


def reload_extension(driver):
    with driver.using_context('chrome'):
        result = driver.execute_async_script("""
          const done = arguments[arguments.length - 1];
          const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
          AddonManager.getAddonByID(arguments[0]).then(addon => addon.reload()).then(
            () => done(null), error => done(String(error)));
        """, script_args=[ADDON_ID])
        assert result is None, result
    open_controller(driver)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firefox', default=shutil.which('firefox') or '/Applications/Firefox.app/Contents/MacOS/firefox')
    parser.add_argument('--headed', action='store_true')
    parser.add_argument('--skip-alarm', action='store_true', help='Explicitly skip the real one-minute alarm')
    parser.add_argument('--restart', action='store_true', help='Test persistent unsigned install; requires Developer Edition/Nightly')
    args = parser.parse_args()
    if not Path(args.firefox).is_file():
        parser.error('Firefox not found; pass --firefox /path/to/firefox')
    with tempfile.TemporaryDirectory(prefix='backstash-firefox-') as temporary, ThreadingHTTPServer(('127.0.0.1', 0), Fixture) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        directory = Path(temporary)
        extension = directory / 'backstash.xpi'
        package(extension)
        driver = None
        try:
            driver = Marionette(
                bin=str(Path(args.firefox).resolve()), port=free_port(), workspace=str(directory),
                app_args=([] if args.headed else ['-headless']) + ['-remote-allow-system-access'],
                gecko_log=str(directory / 'firefox.log'), startup_timeout=30,
                prefs={'browser.startup.page': 3, 'browser.sessionstore.warnOnQuit': False,
                       'browser.warnOnQuitShortcut': False, 'browser.shell.checkDefaultBrowser': False,
                       'xpinstall.signatures.required': False, 'extensions.background.idle.timeout': 100},
            )
            driver.start_session()
            print('Firefox ' + driver.session_capabilities['browserVersion'], flush=True)
            Addons(driver).install(str(extension), temp=not args.restart)
            open_controller(driver)
            fixture_url = f'http://127.0.0.1:{server.server_port}/fixture'
            def scenario(name, arguments=(), timeout=30000):
                return extension_script(driver,
                    "return await (await import('./integration/scenarios.js'))[arguments[0]](...arguments[1]);",
                    [name, list(arguments)], timeout=timeout)
            wake = scenario('prepareWake', [fixture_url])
            wait_for(lambda: chrome(driver, "return WebExtensionPolicy.getByID(arguments[0]).extension.backgroundState === 'stopped';", [ADDON_ID]), 'natural background suspension')
            driver.set_pref('extensions.background.idle.timeout', 300000)
            scenario('verifyWake', [wake])
            print('PASS natural background suspension and message wake', flush=True)
            for name in ['restoreContexts', 'containers', 'groups', 'popup', 'rejectedInputs']:
                scenario(name, [fixture_url])
                print('PASS ' + name, flush=True)
            expected = scenario('prepareReconciliation', [fixture_url])
            reload_extension(driver)
            scenario('verifyReconciliation', [expected])
            print('PASS actual extension reload: missing/orphan alarms and overdue restore', flush=True)
            if args.skip_alarm:
                print('SKIP real one-minute alarm (--skip-alarm)', flush=True)
            else:
                alarm = scenario('prepareAlarm', [fixture_url])
                print('Waiting for real one-minute alarm...', flush=True)
                wait_for(lambda: scenario('alarmFinished', [alarm]), 'real alarm restore', timeout=90)
                print('PASS real one-minute alarm', flush=True)
            if args.restart:
                expected = scenario('prepareReconciliation', [fixture_url])
                driver.restart(in_app=True)
                open_controller(driver)
                scenario('verifyReconciliation', [expected])
                print('PASS actual browser restart: retained storage and recreated alarms', flush=True)
            else:
                print('SKIP browser restart: use --restart with Developer Edition/Nightly', flush=True)
            print('Firefox checks completed.', flush=True)
        except BaseException:
            log = directory / 'firefox.log'
            if log.exists():
                print('\n'.join(log.read_text(errors='replace').splitlines()[-15:]), flush=True)
            raise
        finally:
            if driver and driver.instance:
                driver.cleanup()
            server.shutdown()
            thread.join()


if __name__ == '__main__':
    main()
