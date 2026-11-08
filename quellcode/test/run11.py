import json, os, subprocess, sys, time, shutil
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = os.path.join(ROOT, "test", "build")
shutil.rmtree(T, ignore_errors=True)
shutil.copytree(os.path.join(ROOT, "dist"), T)
os.makedirs(os.path.join(T, "src"), exist_ok=True)
for f in os.listdir(os.path.join(ROOT, "src")):
    shutil.copy(os.path.join(ROOT, "src", f), os.path.join(T, "src", f))
shutil.copy(os.path.join(ROOT, "test", "mock-graph.js"), os.path.join(T, "src", "graph.js"))
subprocess.run(["npx", "esbuild", os.path.join(T, "src", "main.js"), "--bundle", "--format=iife",
                "--outfile=" + os.path.join(T, "app.js"), "--log-level=warning"], check=True, cwd=ROOT)
with open(os.path.join(T, "index.html")) as fh:
    html = fh.read().replace("app.js?v=1.2.0", "app.js")
open(os.path.join(T, "index.html"), "w").write(html)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", T], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

SHOT = os.path.join(ROOT, "test", "shots11"); os.makedirs(SHOT, exist_ok=True)
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
    page.on("dialog", lambda dlg: dlg.accept())
    U = "http://localhost:8765/"
    page.goto(U); page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(600)

    def verbinde(pfad, name, kurz, typ="einzel", ges=None, admins=None):
        page.click("nav >> text=Einstellungen")
        page.click("text=Betriebsordner verbinden"); page.click("text=In meinem OneDrive suchen")
        for x in pfad: page.click(f"ul.ordner li:has-text('{x}')")
        page.click("button:has-text('verwenden')"); page.wait_for_timeout(400)
        page.fill("#cfgform input[name=name]", name); page.fill("#cfgform input[name=kurz]", kurz)
        page.select_option("#cfgform select[name=typ]", typ)
        if ges:
            page.fill("#cfgform input[name=g0name]", ges[0]); page.fill("#cfgform input[name=g1name]", ges[1])
        if admins: page.fill("#cfgform textarea[name=admins]", admins)
        page.click("#cfgform button[type=submit]"); page.wait_for_timeout(500)

    verbinde(["Steuer", "Schuhkarton_Steuer", "Privat"], "Privat", "Privat", admins="eli@example.com\nmann@example.com")
    verbinde(["Steuer", "Schuhkarton_Steuer", "regulationwiseGbR"], "regulation.wise GbR", "GbR", "gbr", ["Elizabeth", "Partnerin"], "eli@example.com\nmann@example.com")
    page.click("nav >> text=Einstellungen"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/01-einstellungen-admin.png", full_page=True)
    page.click("li:has-text('regulation.wise GbR') >> text=Personen freischalten"); page.wait_for_timeout(300)
    page.fill("#einladen input[name=email]", "partner@example.com"); page.click("#einladen button[type=submit]"); page.wait_for_timeout(500)
    page.screenshot(path=f"{SHOT}/02-einladung.png", full_page=True)
    text = page.input_value("#einladungstext")
    link = [l for l in text.split("\n") if "einladung=" in l][0].strip()
    page.click("text=Fertig")
    page.click("li:has-text('regulation.wise GbR') >> text=Personen freischalten"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/03-personen.png", full_page=True)
    page.click("text=Schließen")

    # zweites Gerät von Eli: lokale Daten weg, Verbindungen müssen aus OneDrive kommen
    page.evaluate("for (const k of Object.keys(localStorage)) if (k.startsWith('sk_')) localStorage.removeItem(k)")
    page.reload(); page.wait_for_timeout(1200)
    zweites = page.inner_text("header")
    page.screenshot(path=f"{SHOT}/04-zweites-geraet.png")

    # Partnerin
    page.evaluate("for (const k of Object.keys(localStorage)) if (k.startsWith('sk_')) localStorage.removeItem(k); localStorage.setItem('mock_user','partner@example.com')")
    page.goto(link); page.wait_for_timeout(1500)
    partner_header = page.inner_text("header")
    page.screenshot(path=f"{SHOT}/05-partner-verbunden.png")
    page.click("nav >> text=Einstellungen"); page.wait_for_timeout(300)
    partner_settings = page.inner_text("main")
    page.screenshot(path=f"{SHOT}/06-partner-einstellungen.png", full_page=True)
    page.click("text=Betriebsordner verbinden"); page.click("text=In meinem OneDrive suchen")
    page.click("ul.ordner li:has-text('Dokumente')"); page.click("button:has-text('verwenden')"); page.wait_for_timeout(500)
    nicht = page.inner_text("#modal")
    b.close()
srv.terminate()
print(json.dumps({"errors": errors, "link": link[:80], "zweites_geraet": zweites, "partner_header": partner_header,
  "partner_hat_betriebsdaten_knopf": "Betriebsdaten" in partner_settings, "partner_rolle": [l for l in partner_settings.split("\n") if "Rolle" in l],
  "nicht_eingerichtet": nicht[:120]}, indent=1, ensure_ascii=False))
