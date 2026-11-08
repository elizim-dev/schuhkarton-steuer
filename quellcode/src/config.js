// Feste Konfiguration der App „Schuhkarton Steuer“
export const VERSION = "1.2.0";

export const CLIENT_ID = "e15c462d-09ab-471a-bda0-7b7b06581e86";
export const REGISTERED_REDIRECT = "https://elizim-dev.github.io/schuhkarton-steuer/";

// Lokal (Test) die aktuelle Adresse verwenden, sonst die registrierte Adresse
export const REDIRECT_URI =
  location.hostname === "elizim-dev.github.io"
    ? REGISTERED_REDIRECT
    : location.origin + location.pathname.replace(/index\.html$/, "");

export const SCOPES = ["Files.ReadWrite.All", "User.Read"];
export const GRAPH = "https://graph.microsoft.com/v1.0";

// Dateinamen im Betriebsordner
export const CONFIG_FILE = "schuhkarton-config.json";
export const JOURNAL_FILE = "schuhkarton-journal.json";
export const BELEGE_FOLDER = "Belege";

// KI
export const KI_MODELLE = [
  { id: "claude-haiku-5-5", label: "Haiku (günstig, schnell)" },
  { id: "claude-sonnet-5-5", label: "Sonnet (genauer)" },
];
export const KI_STANDARD = "claude-haiku-5-5";

// Pauschalen (Stand 2026 – bei Gesetzesänderungen anpassen)
export const KM_PAUSCHALE_CENT = 30; // 0,30 € je gefahrenem km (Dienstreise, eigener Pkw)
export const HOMEOFFICE_TAG_CENT = 600; // 6 € je Tag
export const HOMEOFFICE_MAX_CENT = 126000; // 1.260 € je Jahr

export const KATEGORIEN_EINNAHME = [
  "Betriebseinnahmen (Kleinunternehmer)",
  "Sonstige Einnahmen",
];

export const KATEGORIEN_AUSGABE = [
  "Software, Abos, Lizenzen",
  "Hardware unter 800 € (GWG)",
  "Bürobedarf, Porto",
  "Telefon, Internet (anteilig)",
  "Fortbildung",
  "Fachliteratur",
  "Fahrtkosten eigener Pkw",
  "Reisekosten",
  "Werbung, Website, Hosting",
  "Bewirtung",
  "Versicherungen, Beiträge",
  "Fremdleistungen",
  "Bankgebühren",
  "Homeoffice-Pauschale",
  "Raumkosten",
  "Sonstige Ausgaben",
];

// Alte Kategorien (bis Version 1.1) → neue Kategorien
export const KATEGORIE_MIGRATION = {
  "Betriebseinnahmen (Kleinunternehmer)": "Betriebseinnahmen (Kleinunternehmer)",
  "Fortbildung, Fachliteratur": "Fortbildung",
  "Reise- und Fahrtkosten": (e) => (/km/.test(e.pauschale || "") ? "Fahrtkosten eigener Pkw" : "Reisekosten"),
  "Raumkosten, Homeoffice-Pauschale": (e) => (/homeoffice/i.test(e.pauschale || "") ? "Homeoffice-Pauschale" : "Raumkosten"),
  "Bewirtung (70 %)": "Bewirtung",
  "Versicherungen, Beiträge (betrieblich)": "Versicherungen, Beiträge",
};

// Zuordnung Kategorie → Anlage EÜR 2026 (Zeilennummern nur, wo anhand des Vordrucks 2026 belegt;
// maßgeblich für die Eingabe im Steuerprogramm ist die Bezeichnung)
export const EUER_ZEILEN = [
  { id: "ku", typ: "einnahme", zeile: "12", bez: "Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer", kat: ["Betriebseinnahmen (Kleinunternehmer)", "Sonstige Einnahmen"] },
  { id: "fremd", typ: "ausgabe", zeile: "", bez: "Bezogene Fremdleistungen", kat: ["Fremdleistungen"] },
  { id: "gwg", typ: "ausgabe", zeile: "35", bez: "Aufwendungen für geringwertige Wirtschaftsgüter", kat: ["Hardware unter 800 € (GWG)"] },
  { id: "raum", typ: "ausgabe", zeile: "40–43", bez: "Raumkosten und sonstige Grundstücksaufwendungen", kat: ["Raumkosten"] },
  { id: "tk", typ: "ausgabe", zeile: "44", bez: "Aufwendungen für Telekommunikation", kat: ["Telefon, Internet (anteilig)"] },
  { id: "reise", typ: "ausgabe", zeile: "45", bez: "Übernachtungs- und Reisenebenkosten bei Geschäftsreisen", kat: ["Reisekosten"] },
  { id: "fortb", typ: "ausgabe", zeile: "46", bez: "Fortbildungskosten (ohne Reisekosten)", kat: ["Fortbildung"] },
  { id: "beitr", typ: "ausgabe", zeile: "", bez: "Beiträge, Gebühren, Abgaben und Versicherungen", kat: ["Versicherungen, Beiträge"] },
  { id: "werb", typ: "ausgabe", zeile: "", bez: "Werbekosten", kat: ["Werbung, Website, Hosting"] },
  { id: "uebrig", typ: "ausgabe", zeile: "", bez: "Übrige unbeschränkt abziehbare Betriebsausgaben", kat: ["Software, Abos, Lizenzen", "Bürobedarf, Porto", "Fachliteratur", "Bankgebühren", "Sonstige Ausgaben"] },
  { id: "bew", typ: "ausgabe", zeile: "64", bez: "Bewirtungsaufwendungen (abziehbarer Teil 70 %)", kat: ["Bewirtung"], quote: 0.7 },
  { id: "ho", typ: "ausgabe", zeile: "67", bez: "Tagespauschale für die Tätigkeit in der häuslichen Wohnung", kat: ["Homeoffice-Pauschale"] },
  { id: "fahrt", typ: "ausgabe", zeile: "", bez: "Fahrtkosten für nicht zum Betriebsvermögen gehörende Fahrzeuge (Nutzungseinlage)", kat: ["Fahrtkosten eigener Pkw"] },
];

export const GWG_GRENZE_BRUTTO_CENT = 95200; // 800 € netto + 19 % USt
export const KU_GRENZE_VORJAHR_CENT = 2500000;
export const KU_GRENZE_LAUFEND_CENT = 10000000;
export const VORLAGEN_FILE = "schuhkarton-vorlagen.json";


export const EIGENBELEG_GRUENDE = [
  "Pauschale (kein Beleg vorgesehen)",
  "Originalbeleg verloren",
  "Kein Beleg ausgestellt",
  "Interne Buchung (Einlage/Entnahme)",
  "Wiederkehrende Buchung (Anteil aus privater Rechnung)",
  "Sonstiges",
];

// Persönliche Verbindungsliste im App-Ordner der jeweiligen Person (OneDrive/Apps/…)
export const VERBINDUNGEN_FILE = "verbindungen.json";
