import type { VorlagenEintrag } from './vorlage';

/**
 * Die mitgelieferten Regel-Vorlagen (CONTEXT „Regel-Vorlage").
 *
 * Versionierte Daten im Container-Image, aktualisiert **mit Releases** — kein Nachlade-Kanal neben
 * dem Releases-Check, keine Netzwerkabhängigkeit im Betrieb. `synchronisiereVorlagen()` spielt sie
 * beim Start ein und überschreibt eine vorhandene Vorlage nur bei **höherer `version`**.
 *
 * **Aufnahmekriterium: das Betreff-Format muss belegt sein.** Eine kuratierte Vorlage, die nichts
 * trifft, ist schlechter als keine — sie kostet den Betreiber das Vertrauen in alle anderen. Die
 * Liste ist deshalb bewusst kurz und wächst mit jedem Release, in dem jemand ein Format wirklich
 * nachgesehen hat. Jede Vorlage nennt ihre Quelle.
 *
 * Absender bleiben leer: sie sind bei jedem Betreiber andere („veeam@kunde-a.de"). Das
 * Match-Kriterium trägt hier das Betreff-Muster, und der Wizard zeigt den Absender der
 * Beispiel-Mail daneben zum Übernehmen.
 *
 * Beim Erhöhen einer `version` bitte daran denken: die überschriebene Vorlage kann bereits Regeln
 * gesät haben. Die bleiben, wie sie sind — `regel.vorlage_id` ist reine Herkunft (CONTEXT), keine
 * Verknüpfung, die nachzieht.
 */
export const KURATIERTE_VORLAGEN: VorlagenEintrag[] = [
	{
		schluessel: 'veeam-backup-report',
		name: 'Veeam Backup & Replication — Job-Report',
		hersteller: 'Veeam',
		beschreibung:
			'Der nächtliche Job-Report. Veeams Standard-Betreff ist „[%JobResult%] %JobName% ' +
			'(%ObjectCount% instances) %Issues%“, das Ergebnis steht also in eckigen Klammern vorn. ' +
			'„Warning“ zählt hier als Fehler: der Job ist gelaufen, aber nicht sauber — wer das anders ' +
			'sieht, verschiebt das Muster in den OK-Slot.',
		version: 1,
		vorgeschlageneArt: 'heartbeat',
		absender: [],
		betreffMuster: ['^\\[(Success|Warning|Failed)\\]'],
		schluesselwoerter: [],
		musterSchlecht: ['^\\[(Warning|Failed)\\]'],
		musterGut: ['^\\[Success\\]'],
		// Kein Erwartungs-Default: wann der Job läuft, weiß nur die Instanz — das füllt die
		// Takt-Erkennung aus der Beispiel-Mail, nicht diese Datei.
		parameterDefaults: { karenzSekunden: 3600 }
	},
	{
		schluessel: 'nagios-service-alert',
		name: 'Nagios — Service-Alarm',
		hersteller: 'Nagios',
		beschreibung:
			'PROBLEM und RECOVERY als Paar. Der Standard-Betreff von `notify-service-by-email` lautet ' +
			'„** $NOTIFICATIONTYPE$ Service Alert: $HOSTALIAS$/$SERVICEDESC$ is $SERVICESTATE$ **“. ' +
			'Für Host-Alarme („Host Alert“) gilt dasselbe Schema — dafür eine zweite Regel anlegen, ' +
			'sonst führen beide denselben offenen Zustand.',
		version: 1,
		vorgeschlageneArt: 'paar',
		absender: [],
		betreffMuster: ['^\\*\\* (PROBLEM|RECOVERY|ACKNOWLEDGEMENT) Service Alert:'],
		schluesselwoerter: [],
		musterSchlecht: ['^\\*\\* PROBLEM Service Alert:'],
		musterGut: ['^\\*\\* RECOVERY Service Alert:'],
		parameterDefaults: { maxOffenzeitSekunden: 0 }
	},
	{
		schluessel: 'zabbix-problem',
		name: 'Zabbix — Problem und Entwarnung',
		hersteller: 'Zabbix',
		beschreibung:
			'Die Standard-Nachrichtenvorlagen des Medientyps „Email“ betreffen „Problem: {EVENT.NAME}“ ' +
			'und „Resolved: {EVENT.NAME}“. Wer den Host in den Betreff aufgenommen hat, ergänzt das ' +
			'Muster um seinen Präfix.',
		version: 1,
		vorgeschlageneArt: 'paar',
		absender: [],
		betreffMuster: ['(Problem|Resolved):\\s'],
		schluesselwoerter: [],
		musterSchlecht: ['(^|\\s)Problem:\\s'],
		musterGut: ['(^|\\s)Resolved:\\s'],
		parameterDefaults: { maxOffenzeitSekunden: 0 }
	}
];
