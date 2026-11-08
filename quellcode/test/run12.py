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
    html = fh.read().replace("app.js?v=1.2.1", "app.js")
open(os.path.join(T, "index.html"), "w").write(html)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", T], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)


SHOT = os.path.join(ROOT, "test", "shots12"); os.makedirs(SHOT, exist_ok=True)
pdf_path = os.path.join(ROOT, "test", "rechnung.pdf")
errors, dialogs = [], []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="de-DE")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
    def on_dialog(d):
        dialogs.append(d.message[:90].replace("\n", " | ")); d.accept("x")
    page.on("dialog", on_dialog)
    ki = {"art": "ausgabe", "belegdatum": "2026-03-14", "betrag": 49.9, "waehrung": "EUR", "partner": "Telekom", "rechnungsnr": "T-1", "kategorie": "Telefon, Internet (anteilig)", "beschreibung": "Mobilfunk März", "bezahlt": True, "zahlungsdatum": "2026-03-14", "begruendung": "Telefonrechnung", "unsicher": []}
    page.route("https://api.anthropic.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"content": [{"type": "tool_use", "id": "t", "name": "beleg_daten", "input": ki}]})))
    U = "http://localhost:8765/"
    page.goto(U); page.evaluate("localStorage.clear(); localStorage.setItem('sk_apikey', JSON.stringify('sk-test'))"); page.reload(); page.wait_for_timeout(600)

    def verbinde(pfad, name, kurz, typ="einzel", ges=None):
        page.click("nav >> text=Einstellungen")
        page.click("text=Betriebsordner verbinden"); page.click("text=In meinem OneDrive suchen")
        for x in pfad: page.click(f"ul.ordner li:has-text('{x}')")
        page.click("button:has-text('verwenden')"); page.wait_for_timeout(400)
        page.fill("#cfgform input[name=name]", name); page.fill("#cfgform input[name=kurz]", kurz)
        page.select_option("#cfgform select[name=typ]", typ)
        if ges: page.fill("#cfgform input[name=g0name]", ges[0]); page.fill("#cfgform input[name=g1name]", ges[1])
        page.click("#cfgform button[type=submit]"); page.wait_for_timeout(500)

    def ohne(art, betrag, partner="", kat=None, beschr="", extra=None):
        page.click("text=Ohne Beleg"); page.select_option("select[name=art]", art)
        page.fill("input[name=betrag]", betrag)
        if partner: page.fill("input[name=partner]", partner)
        if kat: page.select_option("select[name=kategorie]", kat)
        if beschr: page.fill("input[name=beschreibung]", beschr)
        if extra: extra()
        page.click("form#f button[type=submit]"); page.wait_for_timeout(900)

    verbinde(["Steuer", "Schuhkarton_Steuer", "Privat"], "Privat", "Privat")
    # alte Kategorien einschleusen, um Migration zu testen
    page.evaluate("""() => { const j = Object.values(window.__drive).find(x=>x.name==='schuhkarton-journal.json'); }""")
    # Privat: Beleg mit KI + Anteil 40 %
    page.set_input_files("#dateien", pdf_path); page.wait_for_timeout(1200)
    page.fill("input[name=anteil]", "40"); page.wait_for_timeout(200)
    page.screenshot(path=f"{SHOT}/01-anteil.png", full_page=True)
    page.click("form#f button[type=submit]"); page.wait_for_timeout(1200)
    # Duplikat: gleiches nochmal
    page.set_input_files("#dateien", pdf_path); page.wait_for_timeout(1200)
    page.fill("input[name=anteil]", "40"); page.click("form#f button[type=submit]"); page.wait_for_timeout(1200)
    # Bewirtung ohne Angaben -> Fehler, dann mit
    page.click("text=Ohne Beleg"); page.fill("input[name=betrag]", "80"); page.fill("input[name=partner]", "Restaurant Uhlenhorst")
    page.select_option("select[name=kategorie]", "Bewirtung"); page.click("form#f button[type=submit]"); page.wait_for_timeout(400)
    bew_fehler = page.inner_text("#toast")
    page.fill("input[name=bewAnlass]", "Kooperationsgespräch"); page.fill("input[name=bewTeilnehmende]", "E. Z., M. Muster"); page.fill("input[name=bewOrt]", "Rostock")
    page.screenshot(path=f"{SHOT}/02-bewirtung.png", full_page=True)
    page.click("form#f button[type=submit]"); page.wait_for_timeout(1000)
    ohne("einnahme", "1500", "Kunde A", "Betriebseinnahmen (Kleinunternehmer)", "Workshop")
    ohne("ausgabe", "1200", "Möbelhaus", "Sonstige Ausgaben", "Schreibtisch")  # Anlagegut-Warnung
    # Homeoffice-Pauschale
    def ho():
        page.select_option("select[name=pauschaleTyp]", "ho"); page.fill("input[name=pauschaleMenge]", "100")
    ohne("ausgabe", "1", "Homeoffice", None, "Homeoffice 2026", ho)
    # Migration: alte Kategorie direkt ins Journal schreiben und neu laden
    page.evaluate("""() => { const f = Object.values(window.__drive).find(x=>x.name==='schuhkarton-journal.json'); const j = JSON.parse(f.text); j.eintraege.push({id:'alt1',belegnr:'2026-099',art:'ausgabe',belegdatum:'2026-02-01',zahlungsdatum:'2026-02-01',status:'bezahlt',betragCent:3000,partner:'Alt',kategorie:'Reise- und Fahrtkosten',pauschale:'100 km × 0,30 €',storniert:false}); j.eintraege.push({id:'alt2',belegnr:'2026-098',art:'ausgabe',belegdatum:'2026-02-02',zahlungsdatum:'2026-02-02',status:'bezahlt',betragCent:4500,partner:'Verlag',kategorie:'Fortbildung, Fachliteratur',storniert:false}); f.text = JSON.stringify(j); }""")
    page.wait_for_timeout(400); page.reload(); page.wait_for_timeout(1500)
    page.click("nav >> text=Journal"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/03-journal-privat.png", full_page=True)
    page.click("nav >> text=Auswertung"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/04-auswertung-privat.png", full_page=True)
    ausw_privat = page.inner_text("main")
    page.click("text=erstellen"); page.wait_for_timeout(1500)
    pdf_modal = page.inner_text("#modal"); page.click("text=Fertig")
    # Vorlage anlegen (Privat): Handy 40 %, ab 2026-09
    page.click("nav >> text=Einstellungen")
    page.click("li:has-text('Privat') >> text=Wiederkehrende Buchungen"); page.wait_for_timeout(300)
    page.click("text=Neue Vorlage")
    page.fill("#vorlageform input[name=bezeichnung]", "Handy Coaching-Anteil"); page.fill("#vorlageform input[name=partner]", "Telekom")
    page.fill("#vorlageform input[name=gesamt]", "40"); page.fill("#vorlageform input[name=anteil]", "20"); page.fill("#vorlageform input[name=start]", "2026-09")
    page.click("#vorlageform button[type=submit]"); page.wait_for_timeout(600)
    page.screenshot(path=f"{SHOT}/05-vorlagen.png", full_page=True)
    page.click("text=Fällige jetzt prüfen"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/06-faellig.png", full_page=True)
    page.click("button:has-text('Ausgewählte anlegen')"); page.wait_for_timeout(2500)

    # GbR
    verbinde(["Steuer", "Schuhkarton_Steuer", "regulationwiseGbR"], "regulation.wise GbR", "GbR", "gbr", ["Elizabeth Zimmermann", "Janina Ihbe"])
    ohne("einnahme", "1200", "Kunde Workshop", "Betriebseinnahmen (Kleinunternehmer)")
    def priv_el(): page.select_option("select[name=bezahltVon]", "Elizabeth Zimmermann")
    ohne("ausgabe", "130,36", "Adobe", "Software, Abos, Lizenzen", "", priv_el)
    def sba():
        page.select_option("select[name=bezahltVon]", "Elizabeth Zimmermann"); page.select_option("select[name=behandlung]", "sonderbetriebsausgabe")
    ohne("ausgabe", "48", "Telekom", "Telefon, Internet (anteilig)", "Handy GbR-Anteil", sba)
    ohne("ausgabe", "55,59", "Druckerei", "Werbung, Website, Hosting")
    def ent_el(): page.select_option("select[name=gesellschafterin]", "Elizabeth Zimmermann"); page.select_option("select[name=entnahmeArt]", "privat")
    ohne("entnahme", "330,36", "", None, "Entnahme", ent_el)
    def ent_ja(): page.select_option("select[name=gesellschafterin]", "Janina Ihbe"); page.select_option("select[name=entnahmeArt]", "privat")
    ohne("entnahme", "100", "", None, "Entnahme", ent_ja)
    page.click("nav >> text=Journal"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/07-journal-gbr.png", full_page=True)
    gbr_journal = page.inner_text("main")
    page.click(".ausgleich"); page.wait_for_timeout(200)
    page.click("nav >> text=Auswertung"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/08-auswertung-gbr.png", full_page=True)
    page.click("tr.klick >> nth=0"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOT}/09-zeile.png")
    page.click("text=Schließen")
    page.click("text=erstellen"); page.wait_for_timeout(1500)
    journals = page.evaluate("""() => Object.values(window.__drive).filter(x=>x.name==='schuhkarton-journal.json').map(x=>JSON.parse(x.text))""")
    uploads = page.evaluate("window.__uploads")
    b.close()
srv.terminate()
print(json.dumps({"errors": errors, "dialogs": dialogs, "bew_fehler": bew_fehler, "pdf_modal": pdf_modal[:120]}, indent=1, ensure_ascii=False))
print("UPLOADS", [u["name"] for u in uploads][-6:])
print("AUSW PRIVAT\n", ausw_privat[:900])
print("GBR JOURNAL\n", gbr_journal[:900])
for j in journals:
    for e in j["eintraege"]:
        print(e.get("belegnr"), e["art"], e["betragCent"], e.get("gesamtCent"), e.get("anteilProzent"), e.get("kategorie"), e.get("behandlung"), e.get("periode"))
