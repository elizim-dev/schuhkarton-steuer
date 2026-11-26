import base64, json, os, subprocess, sys, time, shutil
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
    html = fh.read().replace("app.js?v=1.5.0", "app.js")
assert "Content-Security-Policy" in html
open(os.path.join(T, "index.html"), "w").write(html)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", T], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

SHOT = os.path.join(ROOT, "test", "shots15"); os.makedirs(SHOT, exist_ok=True)
errors, dialogs, csp = [], [], []
out = {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="de-DE")
    ctx.add_init_script("""
      document.addEventListener('securitypolicyviolation', e => { (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI); });
      const F = window.File; window.File = class extends F { constructor(...a) { super(...a); window.__lastFile = this; } };
    """)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
    def on_dialog(d):
        dialogs.append(d.type + ": " + d.message[:100].replace("\n", " | ")); d.accept("x")
    page.on("dialog", on_dialog)
    U = "http://localhost:8765/"
    ki = {"art": "ausgabe", "belegdatum": "2026-11-20", "betrag": 60.0, "waehrung": "EUR", "partner": "Restaurant Uhlenhorst", "rechnungsnr": "", "kategorie": "Bewirtung", "beschreibung": "", "bezahlt": True, "zahlungsdatum": "2026-11-20", "begruendung": "Restaurant", "unsicher": []}
    page.route("https://api.anthropic.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"content": [{"type": "tool_use", "id": "t", "name": "beleg_daten", "input": ki}]})))
    page.goto(U); page.evaluate("localStorage.clear(); localStorage.setItem('sk_apikey', JSON.stringify('sk-test'))"); page.reload(); page.wait_for_timeout(600)

    def verbinde(pfad, name, kurz, typ="einzel", ges=None, inhaber=None):
        page.click("nav >> text=Einstellungen")
        page.click("text=Betriebsordner verbinden"); page.click("text=In meinem OneDrive suchen")
        for x in pfad: page.click(f"ul.ordner li:has-text('{x}')")
        page.click("button:has-text('verwenden')"); page.wait_for_timeout(400)
        page.fill("#cfgform input[name=name]", name); page.fill("#cfgform input[name=kurz]", kurz)
        page.select_option("#cfgform select[name=typ]", typ)
        if inhaber: page.fill("#cfgform input[name=inhaber]", inhaber)
        if ges: page.fill("#cfgform input[name=g0name]", ges[0]); page.fill("#cfgform input[name=g1name]", ges[1])
        page.click("#cfgform button[type=submit]"); page.wait_for_timeout(600)

    def ohne(art, betrag, partner="", kat=None, beschr="", extra=None):
        page.click("nav >> text=Erfassen"); page.click("text=Ohne Beleg"); page.select_option("select[name=art]", art)
        if betrag: page.fill("input[name=betrag]", betrag)
        if partner: page.fill("input[name=partner]", partner)
        if kat: page.select_option("select[name=kategorie]", kat)
        if beschr: page.fill("input[name=beschreibung]", beschr)
        if extra: extra()
        page.click("form#f button[type=submit]"); page.wait_for_timeout(900)
        return page.inner_text("#toast")

    pdf_path = os.path.join(ROOT, "test", "rechnung.pdf")
    verbinde(["Steuer", "Schuhkarton_Steuer", "regulationwiseGbR"], "regulation.wise GbR", "GbR", "gbr", ["Elizabeth Zimmermann", "Janina Ihbe"])
    ohne("einnahme", "1200", "Kunde Workshop", "Betriebseinnahmen (Kleinunternehmer)")
    # Restaurantrechnung fotografieren -> KI sagt Bewirtung
    page.click("nav >> text=Erfassen")
    page.set_input_files("#dateien", pdf_path); page.wait_for_timeout(1500)
    out["bew_form"] = page.evaluate("() => { const f=document.getElementById('f'); const vis = s => getComputedStyle(f.querySelector(`[data-show=${s}]`)).display !== 'none'; return {anteil: vis('anteil'), bewHinweis: vis('bewHinweis'), bewNurGes: vis('bewNurGes'), kat: f.kategorie.value, betrag: f.betrag.value}; }")
    page.screenshot(path=f"{SHOT}/01-bewirtung.png", full_page=True)
    page.click("[data-act=als-entnahme]"); page.wait_for_timeout(300)
    out["nach_umstellen"] = page.evaluate("() => { const f=document.getElementById('f'); return [f.art.value, f.entnahmeArt.value, f.gesellschafterin.value, f.auf0.value, f.auf1.value, f.beschreibung.value, f.betrag.value]; }")
    page.fill("input[name=auf1]", "25"); page.wait_for_timeout(200)
    out["summe_falsch"] = page.inner_text("[data-lbl=aufteilung]")
    page.click("form#f button[type=submit]"); page.wait_for_timeout(500)
    out["toast_falsch"] = page.inner_text("#toast")
    page.fill("input[name=auf0]", "35"); page.wait_for_timeout(200)
    page.screenshot(path=f"{SHOT}/02-aufteilung.png", full_page=True)
    page.click("form#f button[type=submit]"); page.wait_for_timeout(1500)
    out["toast_ok"] = page.inner_text("#toast")
    # anteilige Ausgabe 50 € zu 90 %
    def anteil():
        page.fill("input[name=anteil]", "90")
    ohne("ausgabe", "50", "Telekom", "Telefon, Internet (anteilig)", "Handy", anteil)
    page.click("nav >> text=Journal"); page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOT}/03-journal.png", full_page=True)
    out["journal"] = page.inner_text("main")
    page.click("li:has-text('Privatentnahme')"); page.wait_for_timeout(300)
    out["detail"] = page.inner_text("#modal")
    page.click("#modal >> text=Schließen")
    # Aktualisieren
    page.click("button[data-act=aktualisieren]"); page.wait_for_timeout(1200)
    out["aktualisiert"] = page.inner_text("#toast")
    # Versionshinweis
    open(os.path.join(T, "version.json"), "w").write('{"version":"9.9.9"}')
    page.reload(); page.wait_for_timeout(2000)
    out["banner"] = page.evaluate("() => { const e=document.getElementById('update-hinweis'); return e && !e.hidden ? e.innerText : null; }")
    page.screenshot(path=f"{SHOT}/04-banner.png")
    page.click("nav >> text=Auswertung"); page.wait_for_timeout(300)
    page.click("text=erstellen"); page.wait_for_timeout(1500)
    pdfb64 = page.evaluate("async () => { const f = window.__lastFile; const b = new Uint8Array(await f.arrayBuffer()); let s=''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }")
    open("/tmp/euer15.pdf", "wb").write(base64.b64decode(pdfb64))
    out["csp"] = page.evaluate("window.__csp || []")
    b.close()
srv.terminate()
print(json.dumps({"errors": errors, "dialogs": dialogs}, indent=1, ensure_ascii=False))
for k, v in out.items():
    print("==", k, "==\n", v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
