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
    html = fh.read().replace("app.js?v=1.7.0", "app.js")
assert "Content-Security-Policy" in html
open(os.path.join(T, "index.html"), "w").write(html)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", T], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

SHOT = os.path.join(ROOT, "test", "shots16"); os.makedirs(SHOT, exist_ok=True)
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
    ki = {"art": "ausgabe", "belegdatum": "2026-11-20", "betrag": 89.9, "waehrung": "EUR", "partner": "Deutsche Bahn", "rechnungsnr": "", "kategorie": "Reisekosten", "beschreibung": "", "bezahlt": True, "zahlungsdatum": "2026-11-20", "begruendung": "Restaurant", "unsicher": []}
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


    try:
        pdf_path = os.path.join(ROOT, "test", "rechnung.pdf")
        bon_path = os.path.join(ROOT, "test", "bon.jpg")
        verbinde(["Steuer", "Schuhkarton_Steuer", "Privat"], "Coaching", "Privat", "einzel", None, "Elizabeth Zimmermann")
        verbinde(["Steuer", "Schuhkarton_Steuer", "regulationwiseGbR"], "regulation.wise GbR", "GbR", "gbr", ["Elizabeth Zimmermann", "Janina Ihbe"])
        ohne("einnahme", "1200", "Kunde Workshop", "Betriebseinnahmen (Kleinunternehmer)")
        # Ausgabe-Kategorien im normalen Formular: ohne Verpflegungsmehraufwand
        page.click("nav >> text=Erfassen"); page.click("text=Ohne Beleg")
        out["kats_normal"] = page.evaluate("() => [...document.querySelectorAll('select[name=kategorie] option')].map(o=>o.value)")
        page.click("text=Verwerfen")
        # --- Reise GbR: 2 Tage Rostock, Pkw + Verpflegung + Ticket + Hotel
        page.click("nav >> text=Erfassen"); page.click("button[data-act=reise]"); page.wait_for_timeout(300)
        page.fill("input[name=ziel]", "Rostock"); page.fill("input[name=anlass]", "Workshop Uni")
        page.fill("input[name=abDatum]", "2026-11-10"); page.fill("input[name=abZeit]", "07:30")
        page.fill("input[name=anDatum]", "2026-11-11"); page.fill("input[name=anZeit]", "19:00")
        page.check("input[name=mitPkw]"); page.fill("input[name=start]", "Berlin"); page.fill("input[name=km]", "100")
        page.check("input[name=mitVerpfl]"); page.check("input[name=hotelFrueh]"); page.wait_for_timeout(200)
        out["verpfl_tabelle"] = page.inner_text("[data-lbl=verpfl]")
        # Ticket per Datei (KI füllt Betrag/Anbieter)
        with page.expect_file_chooser() as fc: page.click("button[data-typ=ticket]")
        fc.value.set_files(pdf_path); page.wait_for_timeout(1500)
        # Hotel per Bild, privat von Janina bezahlt
        with page.expect_file_chooser() as fc: page.click("button[data-typ=hotel]")
        fc.value.set_files(bon_path); page.wait_for_timeout(1500)
        with page.expect_file_chooser() as fc: page.click("button[data-typ=neben]")
        fc.value.set_files(bon_path); page.wait_for_timeout(1500)
        page.fill("input[name=b2_betrag]", "12"); page.fill("input[name=b2_partner]", "Parkhaus Hbf")
        page.fill("input[name=b1_betrag]", "120"); page.fill("input[name=b1_partner]", "Hotel am Hafen"); page.check("input[name=b1_frueh]")
        page.select_option("select[name=b1_bezahltVon]", "Elizabeth Zimmermann"); page.wait_for_timeout(200)
        out["werte_nach_ki"] = page.evaluate("() => { const f=document.getElementById('f'); return [f.ziel.value, f.km.value, f.b0_betrag.value, f.b0_partner.value, f.b1_betrag.value, getComputedStyle(f.querySelector('[data-show=b1_beh]')).display]; }")
        out["summe"] = page.inner_text("[data-lbl=summe]")
        page.screenshot(path=f"{SHOT}/01-reise.png", full_page=True)
        page.click("form#f button[type=submit]"); page.wait_for_timeout(2500)
        out["toast_reise"] = page.inner_text("#toast")
        page.click("nav >> text=Journal"); page.wait_for_timeout(400)
        out["journal"] = page.inner_text("ul.liste")
        page.screenshot(path=f"{SHOT}/02-journal.png", full_page=True)
        out["gesellschafter"] = page.inner_text("section.card:nth-of-type(3)")
        # Filter
        res = {}
        for a in ["reise", "privat", "offen", "einnahme", "ausgabe"]:
            page.select_option("select[data-flt=art]", a); page.wait_for_timeout(200)
            res[a] = page.locator("ul.liste > li").count() if page.locator("ul.liste").count() else 0
        out["filter_optionen"] = page.evaluate("() => [...document.querySelectorAll('select[data-flt=art] option')].map(o=>o.textContent)")
        page.select_option("select[data-flt=art]", ""); page.wait_for_timeout(200)
        out["filter"] = res
        # Reise-Detail
        page.click("li.reise"); page.wait_for_timeout(300)
        out["reise_detail"] = page.inner_text("#modal")
        page.screenshot(path=f"{SHOT}/03-reise-detail.png", full_page=True)
        # Verpflegungsbuchung öffnen
        page.click("#modal li:has-text('Verpflegung')"); page.wait_for_timeout(300)
        out["verpfl_detail"] = page.inner_text("#modal")
        page.click("#modal >> text=Bearbeiten"); page.wait_for_timeout(400)
        out["edit_view"] = page.evaluate("() => [document.querySelector('main h2').innerText, document.getElementById('f').ziel.value, !!document.querySelector('input[type=hidden][name=mitPkw]'), document.getElementById('f').km.value]")
        # Mittag am 11. gestellt, Rückkehr später
        page.check("input[data-mahl='2026-11-11|m']"); page.fill("input[name=anZeit]", "20:00"); page.wait_for_timeout(200)
        out["verpfl_tabelle_edit"] = page.inner_text("[data-lbl=verpfl]")
        page.click("form#f button[type=submit]"); page.wait_for_timeout(2000)
        out["toast_edit"] = page.inner_text("#toast")
        page.click("nav >> text=Journal"); page.wait_for_timeout(300)
        out["journal_nach_edit"] = page.inner_text("ul.liste")
        # zweite Reise gleiche Person, überlappend → Fehler
        page.click("nav >> text=Erfassen"); page.click("button[data-act=reise]")
        page.fill("input[name=ziel]", "Hamburg"); page.fill("input[name=anlass]", "Termin")
        page.fill("input[name=abDatum]", "2026-11-11"); page.fill("input[name=abZeit]", "06:00"); page.fill("input[name=anDatum]", "2026-11-11"); page.fill("input[name=anZeit]", "18:00")
        page.check("input[name=mitVerpfl]"); page.wait_for_timeout(200)
        page.click("form#f button[type=submit]"); page.wait_for_timeout(800)
        out["kollision"] = page.inner_text("#toast")
        # Janina darf am selben Tag
        page.select_option("select[name=person]", "Janina Ihbe")
        page.click("form#f button[type=submit]"); page.wait_for_timeout(1500)
        out["janina"] = page.inner_text("#toast")
        # alte Fahrt (vor 1.6) einschleusen
        page.evaluate("""() => { const it = Object.values(window.__drive).find(x => x.name==='schuhkarton-journal.json' && JSON.parse(x.text).eintraege.some(e=>e.reise)); const j = JSON.parse(it.text);
          j.eintraege.push({id:'alt1', art:'ausgabe', belegdatum:'2026-10-05', betragCent:2000, partner:'Janina Ihbe (eigener Pkw)', kategorie:'Fahrtkosten eigener Pkw', beschreibung:'Berlin – Potsdam und zurück: Kunde', rechnungsnr:'', status:'offen', zahlungsdatum:null, bezahltVon:'betrieb', behandlung:null, gesellschafterin:'', entnahmeArt:null, eigenbelegGrund:'Pauschale (kein Beleg vorgesehen)', pauschale:'x', gesamtCent:null, anteilProzent:null, fahrt:{start:'Berlin', ziel:'Potsdam', anlass:'Kunde', km:50, hinUndZurueck:true, kmGesamt:100, fahrerin:'Janina Ihbe', mitfahrerin:'', satzCent:20, sbaSatzCent:30, sbaCent:3000}, belegnr:'2026-090', eigenbeleg:true, erfasstVon:'x', erfasstAm:'2026-10-05T10:00:00Z', storniert:false, historie:[]});
          it.text = JSON.stringify(j); it.eTag='"99"'; }""")
        page.click("nav >> text=Journal"); page.click("button[data-act=aktualisieren]"); page.wait_for_timeout(1200)
        out["journal_alt"] = page.inner_text("ul.liste")
        page.click("li.reise:has-text('Potsdam')"); page.wait_for_timeout(300)
        page.click("#modal >> text=Reise bearbeiten"); page.wait_for_timeout(400)
        out["alt_edit"] = page.evaluate("() => { const f=document.getElementById('f'); return [f.person.value, f.ziel.value, f.start.value, f.km.value, f.status.value]; }")
        page.fill("input[name=abZeit]", "09:00"); page.fill("input[name=anZeit]", "18:30"); page.check("input[name=mitVerpfl]"); page.wait_for_timeout(200)
        page.click("form#f button[type=submit]"); page.wait_for_timeout(2000)
        out["alt_toast"] = page.inner_text("#toast")
        page.click("nav >> text=Journal"); page.wait_for_timeout(300)
        out["journal_alt2"] = page.inner_text("ul.liste")
        page.click("nav >> text=Auswertung"); page.wait_for_timeout(400)
        out["auswertung_gbr"] = page.inner_text("main")
        # --- Privat: Tagesreise mit Pkw, 10 Std. → Kollision mit GbR-Reise am 10.11.? (Elizabeth)
        page.click("header >> text=Coaching"); page.wait_for_timeout(500)
        page.click("nav >> text=Erfassen"); page.click("button[data-act=reise]")
        page.fill("input[name=ziel]", "Leipzig"); page.fill("input[name=anlass]", "Coaching vor Ort")
        page.fill("input[name=abDatum]", "2026-11-10"); page.fill("input[name=abZeit]", "08:00"); page.fill("input[name=anDatum]", "2026-11-10"); page.fill("input[name=anZeit]", "18:00")
        page.check("input[name=mitVerpfl]"); page.wait_for_timeout(200)
        page.click("form#f button[type=submit]"); page.wait_for_timeout(800)
        out["kollision_betriebe"] = page.inner_text("#toast")
        page.fill("input[name=abDatum]", "2026-11-20"); page.fill("input[name=anDatum]", "2026-11-20")
        page.check("input[name=mitPkw]"); page.fill("input[name=start]", "Berlin"); page.fill("input[name=km]", "190"); page.wait_for_timeout(200)
        out["privat_summe"] = page.inner_text("[data-lbl=summe]")
        page.screenshot(path=f"{SHOT}/04-privat.png", full_page=True)
        page.click("form#f button[type=submit]"); page.wait_for_timeout(2000)
        out["privat_toast"] = page.inner_text("#toast")
        page.click("nav >> text=Journal"); page.wait_for_timeout(300)
        out["privat_journal"] = page.inner_text("main")
        out["privat_filter"] = page.evaluate("() => [...document.querySelectorAll('select[data-flt=art] option')].map(o=>o.textContent)")
        page.click("nav >> text=Auswertung"); page.wait_for_timeout(400)
        out["auswertung_privat"] = page.inner_text("main")
        # Eigenbeleg Verpflegung als PDF prüfen: letzte Upload-Datei
        out["uploads"] = page.evaluate("(window.__uploads||[]).map(u=>u.name)")
        page.click("nav >> text=Auswertung")
        page.click("text=erstellen"); page.wait_for_timeout(1500)
        for nm, ziel in [("2026-11-10_GbR_Eigenbeleg_Verpflegung-Elizabeth-Zimmermann_22,40.pdf", "/tmp/verpfl16.pdf"), ("2026-11-20_Privat_Eigenbeleg_Fahrt-Elizabeth-Zimmermann_114,00.pdf", "/tmp/fahrtp16.pdf")]:
            b64 = page.evaluate("async (n) => { const f = window.__blobs[n]; const b = new Uint8Array(await f.arrayBuffer()); let s=''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }", nm)
            open(ziel, "wb").write(base64.b64decode(b64))
        out["csp"] = page.evaluate("window.__csp || []")

    except Exception as ex:
        errors.append("TEST ABGEBROCHEN: " + str(ex)[:300]); page.screenshot(path=f"{SHOT}/fehler.png", full_page=True)
    b.close()
srv.terminate()
print(json.dumps({"errors": errors, "dialogs": dialogs}, indent=1, ensure_ascii=False))
for k, v in out.items():
    print("==", k, "==\n", v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
