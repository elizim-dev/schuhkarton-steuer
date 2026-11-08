// Berechnungen: Aufteilung GbR, Kapitalkonten, EÜR
import { EUER_ZEILEN, KATEGORIE_MIGRATION } from "./config.js";

export const zahlJahr = (e) => (e.zahlungsdatum || e.belegdatum || "").slice(0, 4);
const bezahlt = (e) => !e.storniert && e.status === "bezahlt";

// Betrag nach Anteilen aufteilen; Rest-Cent an die erste Gesellschafterin
export function aufteilen(cent, gesellschafter) {
  const g = gesellschafter.length ? gesellschafter : [{ anteil: 100 }];
  const teile = g.map((x) => Math.trunc((cent * (x.anteil || 0)) / 100));
  teile[0] += cent - teile.reduce((a, b) => a + b, 0);
  return teile;
}

// Kategorien älterer Versionen umstellen; liefert true, wenn etwas geändert wurde
export function migriereKategorien(journal) {
  let geaendert = false;
  for (const e of journal.eintraege) {
    const m = KATEGORIE_MIGRATION[e.kategorie];
    if (!m) continue;
    const neu = typeof m === "function" ? m(e) : m;
    if (neu !== e.kategorie) {
      e.kategorie = neu;
      geaendert = true;
    }
  }
  return geaendert;
}

// EÜR eines Jahres (Gesamthand; Sonderbetriebsausgaben gehören nicht hinein)
export function euer(journal, jahr) {
  const liste = journal.eintraege.filter((e) => bezahlt(e) && zahlJahr(e) === jahr);
  const zeilen = EUER_ZEILEN.map((z) => {
    const eintraege = liste.filter(
      (e) => e.art === z.typ && z.kat.includes(e.kategorie) && e.behandlung !== "sonderbetriebsausgabe",
    );
    const brutto = eintraege.reduce((s, e) => s + e.betragCent, 0);
    const betrag = z.quote ? Math.round(brutto * z.quote) : brutto;
    return { ...z, eintraege, brutto, betrag, nichtAbziehbar: brutto - betrag };
  });
  const be = zeilen.filter((z) => z.typ === "einnahme").reduce((s, z) => s + z.betrag, 0);
  const ba = zeilen.filter((z) => z.typ === "ausgabe").reduce((s, z) => s + z.betrag, 0);
  // Buchungen mit Kategorie, die keiner Zeile zugeordnet ist
  const bekannt = new Set(EUER_ZEILEN.flatMap((z) => z.kat));
  const ohneZuordnung = liste.filter((e) => (e.art === "einnahme" || e.art === "ausgabe") && !bekannt.has(e.kategorie));
  return { zeilen, be, ba, gewinn: be - ba, ohneZuordnung };
}

// Kassensicht eines Jahres: Einnahmen/Ausgaben (tatsächlich gezahlt, ohne SBA)
export function ergebnis(journal, jahr) {
  const liste = journal.eintraege.filter((e) => bezahlt(e) && zahlJahr(e) === jahr);
  const ein = liste.filter((e) => e.art === "einnahme").reduce((s, e) => s + e.betragCent, 0);
  const aus = liste.filter((e) => e.art === "ausgabe" && e.behandlung !== "sonderbetriebsausgabe").reduce((s, e) => s + e.betragCent, 0);
  return { ein, aus, ueberschuss: ein - aus };
}

// Gesellschafterinnen: Einlagen, Entnahmen, Kapitalkonto, SBA, steuerlicher Gewinnanteil
export function gesellschafterUebersicht(journal, config, jahr) {
  const ges = (config.gesellschafter || []).filter((g) => g.name);
  const jahreBis = (j) => [...new Set(journal.eintraege.map(zahlJahr))].filter((x) => x && x < j);
  const bewegungen = (j) => {
    const liste = journal.eintraege.filter((e) => bezahlt(e) && zahlJahr(e) === j);
    const r = ergebnis(journal, j);
    const anteile = aufteilen(r.ueberschuss, ges);
    return ges.map((g, i) => {
      const s = (fn) => liste.filter(fn).reduce((a, e) => a + e.betragCent, 0);
      const einlagen = s(
        (e) => (e.art === "ausgabe" && e.bezahltVon === g.name && (e.behandlung === "einlage" || e.behandlung === "erstattung")) ||
          (e.art === "einlage" && e.gesellschafterin === g.name),
      );
      const entnahmen = s((e) => e.art === "entnahme" && e.gesellschafterin === g.name);
      const sba = s((e) => e.art === "ausgabe" && e.bezahltVon === g.name && e.behandlung === "sonderbetriebsausgabe");
      return { name: g.name, anteil: anteile[i], einlagen, entnahmen, sba };
    });
  };
  const aktuell = bewegungen(jahr);
  // Vortrag aus Vorjahren (Kapitalkonto)
  const vortrag = ges.map(() => 0);
  for (const j of jahreBis(jahr)) bewegungen(j).forEach((p, i) => (vortrag[i] += p.anteil + p.einlagen - p.entnahmen));
  const steuer = aufteilen(euer(journal, jahr).gewinn, ges);
  const personen = aktuell.map((p, i) => ({
    ...p,
    vortrag: vortrag[i],
    kapital: vortrag[i] + p.anteil + p.einlagen - p.entnahmen,
    gewinnSteuer: steuer[i] - p.sba,
  }));
  const kap = personen.map((p) => p.kapital);
  const differenz = kap.length > 1 ? Math.max(...kap) - Math.min(...kap) : 0;
  // Rundung bei der Gewinnaufteilung: höchstens 1 Cent je einbezogenem Jahr
  const rundungsToleranz = 1 + jahreBis(jahr).length;
  return { personen, differenz, ausgeglichen: differenz <= rundungsToleranz, hatVortrag: vortrag.some((v) => v !== 0) };
}

// Fällige Perioden einer wiederkehrenden Buchung bis heute
export function faelligePerioden(v, heuteIso) {
  const schritt = { monatlich: 1, vierteljaehrlich: 3, jaehrlich: 12 }[v.rhythmus] || 1;
  const [sy, sm] = v.start.split("-").map(Number);
  const [hy, hm] = heuteIso.slice(0, 7).split("-").map(Number);
  const ende = v.ende ? v.ende.split("-").map(Number) : null;
  const out = [];
  let y = sy;
  let m = sm;
  while (y < hy || (y === hy && m <= hm)) {
    if (ende && (y > ende[0] || (y === ende[0] && m > ende[1]))) break;
    const p = `${y}-${String(m).padStart(2, "0")}`;
    if (!(v.erledigt || []).includes(p)) out.push(p);
    m += schritt;
    while (m > 12) { m -= 12; y += 1; }
  }
  return out;
}
