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
    html = fh.read().replace("app.js?v=1.1.1", "app.js")
open(os.path.join(T, "index.html"), "w").write(html)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", T], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
SHOT = os.path.join(ROOT, "test", "shots")
os.makedirs(SHOT, exist_ok=True)

# Testbeleg-PDF
pdf_path = os.path.join(ROOT, "test", "rechnung.pdf")
from PIL import Image, ImageDraw
im = Image.new("RGB", (800, 1100), "white"); d = ImageDraw.Draw(im)
d.text((50, 50), "Adobe Systems Rechnung Nr. A-123 vom 14.03.2026", fill="black"); d.text((50, 100), "Summe 23,79 EUR", fill="black")
im.save(pdf_path)
jpg_path = os.path.join(ROOT, "test", "bon.jpg"); im.save(jpg_path)

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
    page.on("dialog", lambda dlg: dlg.accept("Test-Storno"))

    ki_answers = [
        {"art": "ausgabe", "belegdatum": "2026-03-14", "betrag": 23.79, "waehrung": "EUR", "partner": "Adobe Systems",
         "rechnungsnr": "A-123", "kategorie": "Software, Abos, Lizenzen", "beschreibung": "Acrobat Abo März",
         "bezahlt": True, "zahlungsdatum": "2026-03-14", "begruendung": "Software-Abonnement.", "unsicher": ["rechnungsnr"]},
    ]
    def ki_route(route):
        body = json.loads(route.request.post_data)
        if body["max_tokens"] == 10:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": [{"type": "text", "text": "OK"}]}))
        ans = ki_answers[0]
        if "tools" in body:
            assert body["tool_choice"]["name"] == "beleg_daten"
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"stop_reason": "tool_use", "content": [{"type": "thinking", "thinking": "..."}, {"type": "tool_use", "id": "t1", "name": "beleg_daten", "input": ans}]}))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": [{"type": "text", "text": json.dumps(ans)}]}))
    page.route("https://api.anthropic.com/**", ki_route)

    page.goto("http://localhost:8765/index.html")
    page.wait_for_timeout(800)
    page.screenshot(path=f"{SHOT}/01-start.png")

    # Betrieb Privat verbinden
    page.click("text=Betriebsordner verbinden")
    page.click("text=In meinem OneDrive suchen")
    page.click("li:has-text('Steuer')"); page.click("li:has-text('Schuhkarton_Steuer')")
    page.screenshot(path=f"{SHOT}/02-browser.png")
    page.click("li:has-text('Privat')")
    page.click("button:has-text('verwenden')")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/03-config.png")
    page.fill("#cfgform input[name=name]", "Privat"); page.fill("#cfgform input[name=kurz]", "Privat")
    page.click("#cfgform button[type=submit]")
    page.wait_for_timeout(400)

    # KI-Schlüssel setzen
    page.click("nav >> text=Einstellungen")
    page.fill("#apikey", "sk-ant-test")
    page.click("text=Speichern")
    page.click("text=Testen"); page.wait_for_timeout(300)

    # Beleg per Datei
    page.click("nav >> text=Erfassen")
    page.set_input_files("#dateien", pdf_path)
    page.wait_for_timeout(1200)
    page.screenshot(path=f"{SHOT}/04-ki-ausgefuellt.png", full_page=True)
    page.click("form#f button[type=submit]")
    page.wait_for_timeout(1500)

    # Ohne Beleg: Kilometer
    page.click("text=Ohne Beleg")
    page.select_option("select[name=pauschaleTyp]", "km")
    page.fill("input[name=pauschaleMenge]", "120")
    page.fill("input[name=partner]", "Eigene Fahrt")
    page.fill("input[name=beschreibung]", "Fahrt zum Workshop Rostock")
    page.wait_for_timeout(200)
    page.screenshot(path=f"{SHOT}/05-pauschale.png", full_page=True)
    page.click("form#f button[type=submit]")
    page.wait_for_timeout(1200)

    # Foto (Bild) mit KI
    page.set_input_files("#cam", jpg_path)
    page.wait_for_timeout(1200)
    page.click("form#f button[type=submit]")
    page.wait_for_timeout(1200)

    page.click("nav >> text=Journal"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/06-journal.png", full_page=True)
    page.click("ul.liste li >> nth=0"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/07-detail.png")
    page.click("text=Bearbeiten")
    page.fill("form#f input[name=betrag]", "30,00")
    page.click("form#f button[type=submit]"); page.wait_for_timeout(800)
    page.click("ul.liste li >> nth=0"); page.click("text=Stornieren"); page.wait_for_timeout(800)

    # GbR verbinden über Link
    page.click("nav >> text=Einstellungen")
    page.click("text=Betriebsordner verbinden")
    page.fill("#sharelink", "https://1drv.ms/f/s!abc")
    page.click("text=Link öffnen")
    page.click("li:has-text('Schuhkarton_Steuer')"); page.click("li:has-text('regulationwiseGbR')")
    page.click("button:has-text('verwenden')"); page.wait_for_timeout(300)
    page.fill("#cfgform input[name=g0name]", "Elizabeth"); page.fill("#cfgform input[name=g1name]", "Partnerin")
    page.screenshot(path=f"{SHOT}/08-gbr-config.png", full_page=True)
    page.click("#cfgform button[type=submit]"); page.wait_for_timeout(400)

    page.set_input_files("#dateien", pdf_path); page.wait_for_timeout(1200)
    page.select_option("select[name=bezahltVon]", "Elizabeth")
    page.screenshot(path=f"{SHOT}/09-gbr-privat.png", full_page=True)
    page.click("form#f button[type=submit]"); page.wait_for_timeout(1200)
    page.click("text=Ohne Beleg")
    page.select_option("select[name=art]", "entnahme")
    page.fill("input[name=betrag]", "10")
    page.fill("input[name=beschreibung]", "Teil-Erstattung Adobe")
    page.click("form#f button[type=submit]"); page.wait_for_timeout(1200)
    page.click("nav >> text=Journal"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/10-gbr-journal.png", full_page=True)

    journals = page.evaluate("""() => Object.values(window.__drive).filter(x=>x.name==='schuhkarton-journal.json').map(x=>JSON.parse(x.text))""")
    uploads = page.evaluate("window.__uploads")
    b.close()
srv.terminate()
print(json.dumps({"errors": errors, "uploads": uploads}, indent=1, ensure_ascii=False))
for j in journals:
    for e in j["eintraege"]:
        print(e["belegnr"], e["art"], e["betragCent"], e.get("kategorie"), e.get("bezahltVon"), e.get("behandlung"), e.get("gesellschafterin"), e["datei"]["name"], "STORNO" if e["storniert"] else "", e.get("historie"))
