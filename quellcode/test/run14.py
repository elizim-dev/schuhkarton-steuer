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
    html = fh.read().replace("app.js?v=1.4.0", "app.js")
assert "Content-Security-Policy" in html
open(os.path.join(T, "index.html"), "w").write(html)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", T], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

SHOT = os.path.join(ROOT, "test", "shots14"); os.makedirs(SHOT, exist_ok=True)
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
    page.goto(U); page.evaluate("localStorage.clear()"); page.reload(); page.wait_for_timeout(600)

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

    verbinde(["Steuer", "Schuhkarton_Steuer", "regulationwiseGbR"], "regulation.wise GbR", "GbR", "gbr", ["Elizabeth Zimmermann", "Janina Ihbe"])
    ohne("einnahme", "1200", "Kunde Workshop", "Betriebseinnahmen (Kleinunternehmer)")
    def einl():
        page.select_option("select[name=gesellschafterin]", "Elizabeth Zimmermann")
    ohne("einlage", "100", extra=einl)
    ohne("ausgabe", "19,99", "Testladen", "Bürobedarf, Porto", "Test")
    ohne("ausgabe", "5", "Storno-Test", "Bürobedarf, Porto", "wird storniert")
    page.click("nav >> text=Journal"); page.wait_for_timeout(300)
    # stornieren
    page.click("li:has-text('Storno-Test')"); page.wait_for_timeout(300)
    page.click("#modal >> text=Stornieren"); page.wait_for_timeout(1000)
    out["journal_nach_storno"] = page.inner_text("main")
    page.check("input[data-flt-check=storno]"); page.wait_for_timeout(300)
    out["mit_storno"] = "Storno-Test" in page.inner_text("main")
    # löschen
    page.click("li:has-text('Testladen')"); page.wait_for_timeout(300)
    out["detail_knoepfe"] = page.inner_text("#modal .aktionen") if page.query_selector("#modal .aktionen") else page.inner_text("#modal")[-200:]
    page.click("#modal >> text=Löschen"); page.wait_for_timeout(1500)
    out["loesch_toast"] = page.inner_text("#toast")
    out["journal_nach_loeschen"] = page.inner_text("main")
    page.click("text=Löschprotokoll ansehen"); page.wait_for_timeout(600)
    out["protokoll"] = page.inner_text("#modal")
    page.screenshot(path=f"{SHOT}/01-protokoll.png", full_page=True)
    page.click("#modal >> text=Schließen")
    # Gewinn auszahlen mit Ausgleich
    page.click("button[data-act=gewinn-auszahlen]"); page.wait_for_timeout(300)
    page.fill("#gewinnform input[name=betrag]", "50")
    page.check("#gewinnform input[name=ausgleichen]"); page.wait_for_timeout(200)
    out["vorschau_zu_wenig"] = page.inner_text("#gewinnform")
    page.fill("#gewinnform input[name=betrag]", "1000"); page.wait_for_timeout(200)
    out["vorschau"] = page.inner_text("#gewinnform")
    page.screenshot(path=f"{SHOT}/02-gewinn.png", full_page=True)
    page.click("#gewinnform button[type=submit]"); page.wait_for_timeout(1800)
    out["gewinn_toast"] = page.inner_text("#toast")
    page.screenshot(path=f"{SHOT}/03-journal.png", full_page=True)
    out["journal_ende"] = page.inner_text("main")[:1500]
    page.click("nav >> text=Auswertung"); page.wait_for_timeout(300)
    page.click("text=erstellen"); page.wait_for_timeout(1500)
    pdfb64 = page.evaluate("async () => { const f = window.__lastFile; const b = new Uint8Array(await f.arrayBuffer()); let s=''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }")
    open("/tmp/euer14.pdf", "wb").write(base64.b64decode(pdfb64))
    out["csp"] = page.evaluate("window.__csp || []")
    files = page.evaluate("() => Object.values(window.__drive).map(x=>x.name)")
    b.close()
srv.terminate()
print(json.dumps({"errors": errors, "dialogs": dialogs}, indent=1, ensure_ascii=False))
for k, v in out.items():
    print("==", k, "==\n", v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
print("FILES", [f for f in files if "Testladen" in f or "loesch" in f or "Entnahme" in f])
