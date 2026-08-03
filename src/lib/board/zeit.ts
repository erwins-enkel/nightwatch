/**
 * Zeitangaben, wie das Board sie schreibt.
 *
 * Alles in der **Instanz-Zeitzone** (`einstellungen.zeitzone`), nicht in der des Browsers: derselbe
 * Alarm muss auf jedem Bildschirm dieselbe Uhrzeit tragen, sonst reden zwei Leute im selben Raum
 * über verschiedene 06:00. Es ist auch die Zone, gegen die der Scheduler seine Kalenderpläne
 * rechnet — eine zweite hier wäre eine zweite Wahrheit.
 */

const MINUTE = 60_000;
const STUNDE = 60 * MINUTE;
const TAG = 24 * STUNDE;

export function formatiereZeitpunkt(wert: Date | string, zone: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone: zone,
		dateStyle: 'short',
		timeStyle: 'short'
	}).format(new Date(wert));
}

export function formatiereUhrzeit(wert: Date | string, zone: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, { timeZone: zone, timeStyle: 'short' }).format(
		new Date(wert)
	);
}

/**
 * „seit 2 Std." — die grobe Dauer, in der Sprache der Oberfläche.
 *
 * Bewusst nur eine Einheit: die Alarm-Leiste beantwortet „wie lange steht das schon?", und dafür
 * ist „2 Std." die Antwort, nicht „2 Std. 14 Min. 3 Sek.".
 */
export function formatiereDauer(von: Date | string, jetzt: Date | string, locale: string): string {
	const abstand = new Date(jetzt).getTime() - new Date(von).getTime();
	// `always`, nicht `auto`: „vor 0 Min." ist als Dauer lesbar, „in dieser Minute" nicht.
	const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' });

	if (abstand >= TAG) return format.format(-Math.floor(abstand / TAG), 'day');
	if (abstand >= STUNDE) return format.format(-Math.floor(abstand / STUNDE), 'hour');
	return format.format(-Math.max(0, Math.floor(abstand / MINUTE)), 'minute');
}

/** Der Kopf einer Tagesspalte: „Do 30.07." in der Sprache der Oberfläche. */
export function formatiereTag(datum: string, locale: string): string {
	// Das Datum ist bereits ein Kalendertag der Instanz-Zone; als UTC-Mitternacht gelesen bleibt es
	// genau dieser Tag, statt beim Formatieren noch einmal verschoben zu werden.
	return new Intl.DateTimeFormat(locale, {
		timeZone: 'UTC',
		weekday: 'short',
		day: '2-digit',
		month: '2-digit'
	}).format(new Date(`${datum}T00:00:00Z`));
}

/**
 * Eine Dauer in Sekunden als „45 Min." / „24 Std." / „7 Tage".
 *
 * Die größte Einheit, die glatt aufgeht — ein Tagesreport wird als „24 Std." konfiguriert und soll
 * nicht als „86400 Sek." dastehen. Geht nichts glatt auf, bleiben es Sekunden.
 */
export function formatiereSekunden(sekunden: number, locale: string): string {
	const einheiten = [
		{ unit: 'day' as const, teiler: 86_400 },
		{ unit: 'hour' as const, teiler: 3600 },
		{ unit: 'minute' as const, teiler: 60 }
	];

	const passend = einheiten.find(({ teiler }) => sekunden >= teiler && sekunden % teiler === 0);
	const { unit, teiler } = passend ?? { unit: 'second' as const, teiler: 1 };

	return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(
		sekunden / teiler
	);
}
