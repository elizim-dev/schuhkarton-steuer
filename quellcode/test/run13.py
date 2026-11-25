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
    html = fh.read().replace("app.js?v=1.3.0", "app.js")
assert "Content-Security-Policy" in html
open(os.path.join(T, "index.html"), "w").write(html)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", T], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

SHOT = os.path.join(ROOT, "test", "shots13"); os.makedirs(SHOT, exist_ok=True)
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

    # --- Privat mit Inhaberin, Pauschalen ohne Lieferant ---
    verbinde(["Steuer", "Schuhkarton_Steuer", "Privat"], "Privat", "Privat", inhaber="Elizabeth Zimmermann")
    def ho150():
        page.select_option("select[name=pauschaleTyp]", "ho"); page.fill("input[name=pauschaleMenge]", "150")
    out["privat_ho_toast"] = ohne("ausgabe", "", "", None, "Homeoffice Jan-Sep", ho150)
    def km():
        page.select_option("select[name=pauschaleTyp]", "km"); page.fill("input[name=pauschaleMenge]", "80")
    out["privat_km_toast"] = ohne("ausgabe", "", "", None, "Fahrt Coaching", km)

    # --- GbR ---
    verbinde(["Steuer", "Schuhkarton_Steuer", "regulationwiseGbR"], "regulation.wise GbR", "GbR", "gbr", ["Elizabeth Zimmermann", "Janina Ihbe"])
    ohne("einnahme", "1200", "Kunde Workshop", "Betriebseinnahmen (Kleinunternehmer)")
    # Homeoffice in der GbR: App soll SBA + Elizabeth vorwählen
    page.click("nav >> text=Erfassen"); page.click("text=Ohne Beleg")
    page.select_option("select[name=pauschaleTyp]", "ho"); page.fill("input[name=pauschaleMenge]", "100"); page.wait_for_timeout(200)
    out["gbr_ho_vorwahl"] = page.evaluate("() => { const f=document.getElementById('f'); return [f.bezahltVon.value, f.behandlung.value, f.partner.value, f.betrag.value, getComputedStyle(document.querySelector('[data-show=hoHinweis]')).display]; }")
    page.screenshot(path=f"{SHOT}/01-gbr-ho.png", full_page=True)
    page.click("form#f button[type=submit]"); page.wait_for_timeout(900)

    # Fahrt 1: Janina, 100 km hin und zurück, offen
    page.click("nav >> text=Erfassen")
    page.screenshot(path=f"{SHOT}/02-erfassen.png", full_page=True)
    page.click("button[data-act=fahrt]")
    page.fill("input[name=belegdatum]", "2026-11-12")
    page.fill("input[name=start]", "Rostock"); page.fill("input[name=ziel]", "Berlin"); page.fill("input[name=anlass]", "Workshop Kunde X")
    page.fill("input[name=km]", "100"); page.select_option("select[name=fahrerin]", "Janina Ihbe"); page.select_option("select[name=mitfahrerin]", "Elizabeth Zimmermann")
    page.wait_for_timeout(200)
    page.screenshot(path=f"{SHOT}/03-fahrt-form.png", full_page=True)
    out["fahrt_rechnung"] = page.inner_text(".fahrt-rechnung")
    page.click("form#f button[type=submit]"); page.wait_for_timeout(1000)
    out["fahrt1_toast"] = page.inner_text("#toast")
    # Fahrt 2: Elizabeth, 50 km einfach, bereits überwiesen
    page.click("button[data-act=fahrt]")
    page.fill("input[name=belegdatum]", "2026-10-02")
    page.fill("input[name=start]", "Rostock"); page.fill("input[name=ziel]", "Wismar"); page.fill("input[name=anlass]", "Netzwerktreffen")
    page.fill("input[name=km]", "50"); page.uncheck("input[name=hinUndZurueck]")
    page.select_option("select[name=fahrerin]", "Elizabeth Zimmermann")
    page.select_option("select[name=status]", "bezahlt"); page.fill("input[name=zahlungsdatum]", "2026-10-05")
    page.click("form#f button[type=submit]"); page.wait_for_timeout(1000)
    # Pflichtfeld-Prüfung: Fahrt ohne Anlass
    page.click("button[data-act=fahrt]")
    page.fill("input[name=start]", "A"); page.fill("input[name=ziel]", "B"); page.fill("input[name=km]", "10")
    page.click("form#f button[type=submit]"); page.wait_for_timeout(300)
    out["fahrt_ohne_anlass"] = page.inner_text("#toast")
    page.click("text=Verwerfen")

    page.click("nav >> text=Journal"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/04-journal.png", full_page=True)
    out["journal_vor"] = page.inner_text("main")
    page.click("li:has-text('Fahrt Rostock – Berlin')"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/05-detail.png", full_page=True)
    out["detail"] = page.inner_text("#modal")
    # Bearbeiten: km 100 -> 110
    page.click("#modal >> text=Bearbeiten"); page.wait_for_timeout(300)
    page.fill("#modal input[name=km]", "110")
    page.click("#modal form#f button[type=submit]"); page.wait_for_timeout(1000)
    out["edit_toast"] = page.inner_text("#toast")

    page.click("nav >> text=Auswertung"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/06-auswertung-vor.png", full_page=True)
    out["ausw_vor"] = page.inner_text("main")
    page.click("button[data-act=fahrten-abrechnen]"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/07-abrechnen.png", full_page=True)
    page.fill("#abrechnung input[name=datum]", "2026-12-15")
    page.click("#abrechnung button[type=submit]"); page.wait_for_timeout(1200)
    out["abrechnung_toast"] = page.inner_text("#toast")
    page.screenshot(path=f"{SHOT}/08-auswertung-nach.png", full_page=True)
    out["ausw_nach"] = page.inner_text("main")
    page.click("nav >> text=Journal"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/09-journal-nach.png", full_page=True)
    out["journal_nach"] = page.inner_text("main")[:1400]
    page.click("nav >> text=Auswertung"); page.wait_for_timeout(300)
    page.click("text=erstellen"); page.wait_for_timeout(1500)
    pdfb64 = page.evaluate("async () => { const f = window.__lastFile; const b = new Uint8Array(await f.arrayBuffer()); let s=''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }")
    open("/tmp/euer13.pdf", "wb").write(base64.b64decode(pdfb64))
    page.click("text=Fertig")

    # Privat-Auswertung: Homeoffice-Grenze über beide Betriebe
    page.click("header button:has-text('Privat')"); page.wait_for_timeout(600)
    page.click("nav >> text=Auswertung"); page.wait_for_timeout(300)
    out["ausw_privat"] = page.inner_text("main")[:900]
    page.screenshot(path=f"{SHOT}/10-auswertung-privat.png", full_page=True)

    # --- Sicherheit: manipulierte Journal-Einträge ---
    page.click("header button:has-text('regulation.wise')"); page.wait_for_timeout(600)
    page.evaluate("""() => { const fs = Object.values(window.__drive).filter(x=>x.name==='schuhkarton-journal.json');
      const f = fs.find(x => JSON.parse(x.text).eintraege.some(e => e.fahrt));
      const j = JSON.parse(f.text);
      j.eintraege.push({id:'x"><img src=x onerror=alert(11)>', belegnr:'2026-900', art:'ausgabe', belegdatum:'2026-11-01', zahlungsdatum:'2026-11-01', status:'bezahlt', betragCent:100,
        partner:'<img src=x onerror=alert(12)>', kategorie:'Sonstige Ausgaben', anteilProzent:'<b onmouseover=alert(13)>x</b>', storniert:false,
        datei:{webUrl:'javascript:alert(14)'}, erfasstVon:'x', erfasstAm:'2026-11-01'});
      f.text = JSON.stringify(j); }""")
    page.wait_for_timeout(400); page.reload(); page.wait_for_timeout(1500)
    page.click("nav >> text=Journal"); page.wait_for_timeout(400)
    page.click("li:has-text('2026-900')"); page.wait_for_timeout(400)
    out["xss_beleg_link"] = page.evaluate("() => !!document.querySelector('#modal a[href^=javascript]')")
    page.click("text=Schließen")

    # --- Einladungslinks ---
    def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
    page.goto(U + "?einladung=" + b64({"d": "drive-eli", "i": "../../evil", "n": "<img src=x onerror=alert(15)>"})); page.wait_for_timeout(1500)
    out["invite_bad"] = page.inner_text("#toast")
    page.goto(U + "?einladung=" + "%3Cscript%3E"); page.wait_for_timeout(1200)
    out["invite_garbage_ls"] = page.evaluate("localStorage.getItem('sk_einladung')")
    out["csp"] = page.evaluate("window.__csp || []")
    journals = page.evaluate("""() => Object.values(window.__drive).filter(x=>x.name==='schuhkarton-journal.json').map(x=>JSON.parse(x.text))""")
    ersetzt = page.evaluate("""() => Object.values(window.__drive).filter(x=>x.ersetzt).map(x=>[x.name, x.ersetzt])""")
    b.close()
srv.terminate()
print(json.dumps({"errors": errors, "dialogs": dialogs}, indent=1, ensure_ascii=False))
for k, v in out.items():
    print("==", k, "==\n", v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
print("ERSETZT", ersetzt)
for j in journals:
    for e in j["eintraege"]:
        print(e.get("belegnr"), e["art"], e["betragCent"], e.get("status"), e.get("zahlungsdatum"), e.get("partner"), e.get("kategorie"), e.get("bezahltVon"), e.get("behandlung"), json.dumps(e.get("fahrt"), ensure_ascii=False) if e.get("fahrt") else "")
