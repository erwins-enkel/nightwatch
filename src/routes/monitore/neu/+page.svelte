<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, Highlighter, Wand2 } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import { alsMuster } from '$lib/regel/muster';
	import type { Beleg } from '$lib/server/regel/ableitung';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const schritt = $derived(form?.schritt ?? 1);

	/** Eine Formular-Aktion unter Beibehaltung der Quelle in der URL — siehe `load`. */
	const aktion = $derived(
		(name: string) => `${data.suche === '' ? '?' : `${data.suche}&`}/${name}`
	);
	const fehler = $derived(form?.fehler ?? []);

	/**
	 * Die Werte des Formulars.
	 *
	 * Nach dem ersten „Weiter" ist die Server-Antwort maßgeblich — sie trägt *alle* Felder, auch die
	 * der Schritte, die gerade nicht sichtbar sind. Nur beim ersten Aufruf kommen sie aus der
	 * Vorbefüllung. Ein Feld-für-Feld-Rückfall wäre die Gelegenheit, eines zu vergessen.
	 */
	const aktuell = $derived(form?.eingaben ?? ausVorbefuellung());

	function ausVorbefuellung() {
		const v = data.vorbefuellung;
		const p = v?.parameter;
		const alsText = (wert: number | undefined) => (wert === undefined ? '' : String(wert));

		return {
			kundeId: data.kundeId,
			vorlageId: data.vorlageId,
			vorlageAngewandt: data.vorlageId,
			bezeichnung: v?.bezeichnung ?? '',
			art: v?.art ?? '',
			erwartungModus: p?.erwartungModus ?? '',
			erwartungIntervallSekunden: alsText(p?.erwartungIntervallSekunden),
			uhrzeit: p?.erwartungPlan?.uhrzeit ?? '',
			karenzSekunden: alsText(p?.karenzSekunden),
			autoZurueckSekunden: alsText(p?.autoZurueckSekunden),
			maxOffenzeitSekunden: alsText(p?.maxOffenzeitSekunden),
			zaehlerFensterSekunden: alsText(p?.zaehlerFensterSekunden),
			zaehlerObergrenze: alsText(p?.zaehlerObergrenze),
			zaehlerUntergrenze: alsText(p?.zaehlerUntergrenze),
			entwarnungsStabilitaetSekunden: '',
			absender: (v?.regel.absender ?? []).join('\n'),
			betreffMuster: (v?.regel.betreffMuster ?? []).join('\n'),
			schluesselwoerter: (v?.regel.schluesselwoerter ?? []).join('\n'),
			musterSchlecht: (v?.regel.musterSchlecht ?? []).join('\n'),
			musterGut: (v?.regel.musterGut ?? []).join('\n'),
			wochentage: (p?.erwartungPlan?.wochentage ?? []).map(String)
		};
	}

	type Feld = Exclude<keyof ReturnType<typeof ausVorbefuellung>, 'wochentage'>;

	/** Welches Feld auf welchem Schritt sichtbar ist — der Rest reist als Hidden-Feld mit. */
	const SCHRITT_JE_FELD: Record<Feld, number> = {
		kundeId: 1,
		bezeichnung: 1,
		vorlageId: 1,
		vorlageAngewandt: 0,
		art: 2,
		absender: 3,
		betreffMuster: 3,
		schluesselwoerter: 3,
		musterSchlecht: 3,
		musterGut: 3,
		erwartungModus: 4,
		erwartungIntervallSekunden: 4,
		uhrzeit: 4,
		karenzSekunden: 4,
		autoZurueckSekunden: 4,
		maxOffenzeitSekunden: 4,
		zaehlerFensterSekunden: 4,
		zaehlerObergrenze: 4,
		zaehlerUntergrenze: 4,
		entwarnungsStabilitaetSekunden: 4
	};

	const verborgen = $derived(
		(Object.keys(SCHRITT_JE_FELD) as Feld[]).filter((feld) => SCHRITT_JE_FELD[feld] !== schritt)
	);

	/**
	 * Der Erwartungs-Modus schaltet innerhalb von Schritt 4 zwischen Intervall und Kalenderplan um —
	 * das einzige Feld, das ohne Roundtrip reagieren muss. `null` heißt „noch nicht angefasst", dann
	 * gilt, was der Server geschickt hat.
	 */
	let gewaehlterModus = $state<string | null>(null);
	const modus = $derived(gewaehlterModus ?? aktuell.erwartungModus ?? '');

	/**
	 * Erst nach dem Mounten sichtbar: ohne JavaScript täte der Knopf nichts, und ein Knopf, der
	 * nichts tut, ist schlimmer als keiner. `onMount` statt `browser`, damit Server- und
	 * Erst-Rendern übereinstimmen und die Hydration nichts zu reparieren hat.
	 */
	let markierenMoeglich = $state(false);
	onMount(() => {
		markierenMoeglich = true;
	});

	let beispielFeld: HTMLElement | undefined = $state();
	let schlechtFeld: HTMLTextAreaElement | undefined = $state();
	let gutFeld: HTMLTextAreaElement | undefined = $state();

	/**
	 * Schicht 2: markierter Text aus der Beispiel-Mail wird zum Muster (CONTEXT
	 * „Vorbefüllungs-Grad": „Muster (Schicht 2) … sind immer Menschensache").
	 *
	 * Die Auswahl muss im Beispieltext liegen; sonst würde ein versehentlich markiertes
	 * Bedienelement zum Muster.
	 */
	function uebernehmen(ziel: 'schlecht' | 'gut') {
		const auswahl = window.getSelection();
		const text = auswahl?.toString() ?? '';
		if (text.trim() === '' || !beispielFeld || !auswahl?.anchorNode) return;
		if (!beispielFeld.contains(auswahl.anchorNode)) return;

		const feld = ziel === 'schlecht' ? schlechtFeld : gutFeld;
		if (!feld) return;

		const muster = alsMuster(text);
		const vorhanden = feld.value.replace(/\n+$/, '');
		feld.value = vorhanden === '' ? muster : `${vorhanden}\n${muster}`;
	}

	const FEHLER: Record<string, () => string> = {
		kunde_fehlt: m.wizard_error_customer,
		bezeichnung_leer: m.rule_error_name,
		erwartung_fehlt: m.rule_error_expectation_missing,
		erwartung_unvollstaendig: m.rule_error_expectation_incomplete,
		karenz_fehlt: m.rule_error_grace,
		auto_zurueck_ungueltig: m.rule_error_auto_back,
		offenzeit_ungueltig: m.rule_error_open_time,
		fenster_fehlt: m.rule_error_window,
		grenze_fehlt: m.rule_error_bound_missing,
		grenzen_verdreht: m.rule_error_bounds_swapped,
		grenze_negativ: m.rule_error_bound_negative,
		stabilitaet_negativ: m.rule_error_stability,
		kein_match_kriterium: m.rule_error_no_criterion,
		muster_ungueltig: m.rule_error_pattern,
		slot_ungenutzt: m.rule_error_unused_slot,
		art_unbekannt: m.rule_error_kind,
		unbekannt: m.rule_error_gone
	};

	const ART: Record<string, () => string> = {
		heartbeat: m.kind_heartbeat,
		ereignis: m.kind_event,
		paar: m.kind_pair,
		zaehler: m.kind_counter
	};

	const ART_HINWEIS: Record<string, () => string> = {
		heartbeat: m.wizard_kind_heartbeat_hint,
		ereignis: m.wizard_kind_event_hint,
		paar: m.wizard_kind_pair_hint,
		zaehler: m.wizard_kind_counter_hint
	};

	const SCHRITT_NAME: Record<number, () => string> = {
		1: m.wizard_step_customer,
		2: m.wizard_step_kind,
		3: m.wizard_step_detection,
		4: m.wizard_step_parameters
	};

	const WOCHENTAGE = [1, 2, 3, 4, 5, 6, 7];
	const TAG: Record<number, () => string> = {
		1: m.weekday_mon,
		2: m.weekday_tue,
		3: m.weekday_wed,
		4: m.weekday_thu,
		5: m.weekday_fri,
		6: m.weekday_sat,
		7: m.weekday_sun
	};

	const gewaehlteTage = $derived(new Set(aktuell.wochentage.map(Number)));

	const belege = $derived<Beleg[]>([
		...(data.vorbefuellung?.belege ?? []),
		...(form?.belege ?? [])
	]);

	/** „werktäglich ~05:40, aus 12 Vorkommen" — der Beleg, den CONTEXT jedem Vorschlag abverlangt. */
	function belegText(beleg: Beleg): string {
		switch (beleg.grund) {
			case 'match':
				return m.evidence_match({ absender: beleg.absender, muster: beleg.betreffMuster });
			case 'kein_takt':
				return m.evidence_no_rhythm({ anzahl: beleg.vorkommen });
			case 'karenz':
				return m.evidence_grace({ minuten: Math.round(beleg.streuungSekunden / 60) });
			case 'zaehler':
				return m.evidence_counter({ median: beleg.medianProTag, tage: beleg.tage });
			case 'offenzeit':
				return m.evidence_open_time({
					minuten: Math.round(beleg.maxSekunden / 60),
					paare: beleg.paare
				});
			case 'takt': {
				const takt = beleg.takt;
				const anzahl = takt.vorkommen;
				if (takt.klasse === 'intervall') {
					return m.evidence_rhythm_interval({
						minuten: Math.round((takt.intervallSekunden ?? 0) / 60),
						anzahl
					});
				}
				if (takt.klasse === 'woechentlich') {
					return m.evidence_rhythm_weekly({
						tag: TAG[takt.wochentag ?? 1](),
						uhrzeit: takt.uhrzeit ?? '',
						anzahl
					});
				}
				return takt.klasse === 'werktaeglich'
					? m.evidence_rhythm_workday({ uhrzeit: takt.uhrzeit ?? '', anzahl })
					: m.evidence_rhythm_daily({ uhrzeit: takt.uhrzeit ?? '', anzahl });
			}
		}
	}

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';
	const feldKlasse = 'flex flex-col gap-1';
	const beschriftung = 'text-sm text-slate-300';
	const hinweis = 'text-xs text-slate-500';
	const abschnitt = 'flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4';
	const knopfKlasse =
		'rounded border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500';
	const knopfStark =
		'rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500';
</script>

<svelte:head><title>{m.wizard_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
	<header class="flex flex-col gap-3">
		<a
			href={resolve('/')}
			class="flex w-fit items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
		>
			<ArrowLeft class="size-3" aria-hidden="true" />
			{m.wizard_back()}
		</a>
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<Wand2 class="size-6 text-emerald-400" aria-hidden="true" />
			{m.wizard_title()}
		</h1>
		<p class="text-sm text-slate-400">
			{m.wizard_step_of({ schritt, name: SCHRITT_NAME[schritt]() })}
		</p>
		<ol class="flex gap-1.5" aria-label={m.wizard_progress()}>
			{#each [1, 2, 3, 4] as stufe (stufe)}
				<li
					class="h-1 flex-1 rounded {stufe <= schritt ? 'bg-emerald-500' : 'bg-slate-700'}"
					aria-current={stufe === schritt ? 'step' : undefined}
				></li>
			{/each}
		</ol>
	</header>

	{#if fehler.length > 0}
		<ul
			class="flex list-inside list-disc flex-col gap-1 rounded border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300"
		>
			{#each fehler as schluessel (schluessel)}
				<li>{FEHLER[schluessel]?.() ?? schluessel}</li>
			{/each}
		</ul>
	{/if}

	<form method="POST" use:enhance class="flex flex-col gap-6">
		<input type="hidden" name="von" value={schritt} />
		{#each verborgen as feld (feld)}
			<input type="hidden" name={feld} value={aktuell[feld]} />
		{/each}
		{#if schritt !== 4}
			{#each aktuell.wochentage as tag (tag)}
				<input type="hidden" name="wochentage" value={tag} />
			{/each}
		{/if}

		<!-- Schritt 1 — Kunde & Startrampe ------------------------------------------------------ -->
		{#if schritt === 1}
			<section class={abschnitt}>
				<h2 class="text-lg font-medium text-slate-100">{m.wizard_step_customer()}</h2>

				<div class={feldKlasse}>
					<label class={beschriftung} for="kundeId">{m.wizard_customer()}</label>
					<select
						class={eingabeKlasse}
						id="kundeId"
						name="kundeId"
						value={aktuell.kundeId}
						required
					>
						<option value="">{m.wizard_customer_choose()}</option>
						{#each data.kunden as kunde (kunde.id)}
							<option value={kunde.id}>{kunde.name}</option>
						{/each}
					</select>
					<p class={hinweis}>{m.wizard_customer_hint()}</p>
				</div>

				<div class={feldKlasse}>
					<label class={beschriftung} for="bezeichnung">{m.rule_name()}</label>
					<input
						class={eingabeKlasse}
						id="bezeichnung"
						name="bezeichnung"
						value={aktuell.bezeichnung}
						required
					/>
				</div>

				<div class={feldKlasse}>
					<label class={beschriftung} for="vorlageId">{m.wizard_template()}</label>
					<select class={eingabeKlasse} id="vorlageId" name="vorlageId" value={aktuell.vorlageId}>
						<option value="">{m.wizard_template_none()}</option>
						{#each data.vorlagen as vorlage (vorlage.id)}
							<option value={vorlage.id}>
								{vorlage.hersteller ? `${vorlage.hersteller} — ` : ''}{vorlage.name}
							</option>
						{/each}
					</select>
					<p class={hinweis}>{m.wizard_template_hint()}</p>
				</div>

				{#if data.quelle}
					<p
						class="rounded border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300"
					>
						{m.wizard_derived_from({ betreff: data.quelle.betreff })}
					</p>
				{/if}
			</section>
		{/if}

		<!-- Schritt 2 — Monitor-Art --------------------------------------------------------------- -->
		{#if schritt === 2}
			<section class={abschnitt}>
				<h2 class="text-lg font-medium text-slate-100">{m.wizard_step_kind()}</h2>
				<p class={hinweis}>{m.wizard_kind_hint()}</p>

				<div class="grid gap-3 sm:grid-cols-2">
					{#each data.arten as wahl (wahl)}
						<label
							class="flex cursor-pointer flex-col gap-1 rounded border p-3 {aktuell.art === wahl
								? 'border-emerald-600 bg-emerald-950/20'
								: 'border-slate-700'}"
						>
							<span class="flex items-center gap-2 text-sm font-medium text-slate-100">
								<input
									type="radio"
									name="art"
									value={wahl}
									checked={aktuell.art === wahl}
									class="accent-emerald-500"
								/>
								{ART[wahl]()}
							</span>
							<span class={hinweis}>{ART_HINWEIS[wahl]()}</span>
						</label>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Schritt 3 — Erkennung ----------------------------------------------------------------- -->
		{#if schritt === 3}
			<section class={abschnitt}>
				<h2 class="text-lg font-medium text-slate-100">{m.rule_detection()}</h2>
				<p class={hinweis}>{m.rule_detection_hint()}</p>

				<div class={feldKlasse}>
					<label class={beschriftung} for="absender">{m.rule_sender()}</label>
					<textarea
						class={eingabeKlasse}
						id="absender"
						name="absender"
						rows="2"
						value={aktuell.absender}></textarea>
				</div>

				<div class={feldKlasse}>
					<label class={beschriftung} for="betreffMuster">{m.rule_subject()}</label>
					<textarea
						class={eingabeKlasse}
						id="betreffMuster"
						name="betreffMuster"
						rows="2"
						value={aktuell.betreffMuster}></textarea>
				</div>

				<div class={feldKlasse}>
					<label class={beschriftung} for="schluesselwoerter">{m.rule_keywords()}</label>
					<textarea
						class={eingabeKlasse}
						id="schluesselwoerter"
						name="schluesselwoerter"
						rows="2"
						value={aktuell.schluesselwoerter}></textarea>
				</div>
			</section>

			{#if aktuell.art !== 'zaehler'}
				<section class={abschnitt}>
					<h2 class="text-lg font-medium text-slate-100">{m.rule_slots()}</h2>
					<p class={hinweis}>{m.wizard_slots_hint()}</p>

					{#if aktuell.art !== 'ereignis'}
						<div class={feldKlasse}>
							<label class={beschriftung} for="musterSchlecht">
								{aktuell.art === 'paar' ? m.slot_open() : m.slot_error()}
							</label>
							<textarea
								class={eingabeKlasse}
								id="musterSchlecht"
								name="musterSchlecht"
								rows="2"
								bind:this={schlechtFeld}
								value={aktuell.musterSchlecht}></textarea>
						</div>
					{/if}

					<div class={feldKlasse}>
						<label class={beschriftung} for="musterGut">
							{aktuell.art === 'paar'
								? m.slot_close()
								: aktuell.art === 'ereignis'
									? m.slot_harmless()
									: m.slot_ok()}
						</label>
						<textarea
							class={eingabeKlasse}
							id="musterGut"
							name="musterGut"
							rows="2"
							bind:this={gutFeld}
							value={aktuell.musterGut}></textarea>
					</div>
				</section>
			{:else}
				<p class="rounded border border-slate-800 bg-slate-900/50 px-4 py-3 text-xs text-slate-400">
					{m.wizard_slots_unused()}
				</p>
			{/if}

			{#if data.quelle}
				<section class={abschnitt}>
					<h2 class="flex items-center gap-2 text-lg font-medium text-slate-100">
						<Highlighter class="size-4 text-emerald-400" aria-hidden="true" />
						{m.wizard_example()}
					</h2>
					<p class={hinweis}>
						{markierenMoeglich ? m.wizard_example_hint() : m.wizard_example_hint_nojs()}
					</p>

					<p class="text-xs text-slate-400">
						<b class="text-slate-200">{data.quelle.absender}</b> · {data.quelle.betreff}
					</p>
					<pre
						bind:this={beispielFeld}
						class="max-h-72 overflow-auto rounded border border-slate-800 bg-slate-950 p-3 text-xs whitespace-pre-wrap text-slate-300">{data
							.quelle.bodyText ?? data.quelle.betreff}</pre>

					{#if markierenMoeglich && aktuell.art !== 'zaehler'}
						<div class="flex flex-wrap gap-2">
							{#if aktuell.art !== 'ereignis'}
								<button type="button" class={knopfKlasse} onclick={() => uebernehmen('schlecht')}>
									{aktuell.art === 'paar' ? m.wizard_mark_open() : m.wizard_mark_error()}
								</button>
							{/if}
							<button type="button" class={knopfKlasse} onclick={() => uebernehmen('gut')}>
								{aktuell.art === 'paar'
									? m.wizard_mark_close()
									: aktuell.art === 'ereignis'
										? m.wizard_mark_harmless()
										: m.wizard_mark_ok()}
							</button>
						</div>
					{/if}
				</section>
			{/if}
		{/if}

		<!-- Schritt 4 — Parameter & Bestätigung ---------------------------------------------------- -->
		{#if schritt === 4}
			<section class={abschnitt}>
				<h2 class="text-lg font-medium text-slate-100">{m.rule_parameters()}</h2>

				{#if aktuell.art === 'heartbeat'}
					<fieldset class={feldKlasse}>
						<legend class={beschriftung}>{m.param_expectation()}</legend>
						<label class="flex items-center gap-2 text-sm text-slate-300">
							<input
								type="radio"
								name="erwartungModus"
								value="intervall"
								checked={modus === 'intervall'}
								onchange={() => (gewaehlterModus = 'intervall')}
								class="accent-emerald-500"
							/>
							{m.param_mode_interval()}
						</label>
						<label class="flex items-center gap-2 text-sm text-slate-300">
							<input
								type="radio"
								name="erwartungModus"
								value="kalenderplan"
								checked={modus === 'kalenderplan'}
								onchange={() => (gewaehlterModus = 'kalenderplan')}
								class="accent-emerald-500"
							/>
							{m.param_mode_plan()}
						</label>
					</fieldset>

					{#if modus === 'kalenderplan'}
						<fieldset class={feldKlasse}>
							<legend class={beschriftung}>{m.param_plan_days()}</legend>
							<div class="flex flex-wrap gap-3">
								{#each WOCHENTAGE as tag (tag)}
									<label class="flex items-center gap-1.5 text-sm text-slate-300">
										<input
											type="checkbox"
											name="wochentage"
											value={tag}
											checked={gewaehlteTage.has(tag)}
											class="size-4 accent-emerald-500"
										/>
										{TAG[tag]()}
									</label>
								{/each}
							</div>
						</fieldset>

						<div class={feldKlasse}>
							<label class={beschriftung} for="uhrzeit">{m.param_plan_time()}</label>
							<input
								class={eingabeKlasse}
								id="uhrzeit"
								name="uhrzeit"
								type="time"
								value={aktuell.uhrzeit}
							/>
							<p class={hinweis}>{m.param_plan_time_hint()}</p>
						</div>
					{:else}
						<div class={feldKlasse}>
							<label class={beschriftung} for="erwartungIntervallSekunden">
								{m.param_interval()}
							</label>
							<input
								class={eingabeKlasse}
								id="erwartungIntervallSekunden"
								name="erwartungIntervallSekunden"
								type="number"
								min="1"
								step="1"
								value={aktuell.erwartungIntervallSekunden}
							/>
						</div>
					{/if}

					<div class={feldKlasse}>
						<label class={beschriftung} for="karenzSekunden">{m.param_grace()}</label>
						<input
							class={eingabeKlasse}
							id="karenzSekunden"
							name="karenzSekunden"
							type="number"
							min="0"
							step="1"
							value={aktuell.karenzSekunden}
						/>
						<p class={hinweis}>{m.param_grace_hint()}</p>
					</div>
				{:else if aktuell.art === 'ereignis'}
					<div class={feldKlasse}>
						<label class={beschriftung} for="autoZurueckSekunden">{m.param_auto_back()}</label>
						<input
							class={eingabeKlasse}
							id="autoZurueckSekunden"
							name="autoZurueckSekunden"
							type="number"
							min="1"
							step="1"
							value={aktuell.autoZurueckSekunden}
						/>
						<p class={hinweis}>{m.param_auto_back_hint()}</p>
					</div>
				{:else if aktuell.art === 'paar'}
					<div class={feldKlasse}>
						<label class={beschriftung} for="maxOffenzeitSekunden">{m.param_max_open()}</label>
						<input
							class={eingabeKlasse}
							id="maxOffenzeitSekunden"
							name="maxOffenzeitSekunden"
							type="number"
							min="0"
							step="1"
							value={aktuell.maxOffenzeitSekunden}
						/>
						<p class={hinweis}>{m.param_max_open_hint()}</p>
					</div>
				{:else}
					<div class={feldKlasse}>
						<label class={beschriftung} for="zaehlerFensterSekunden">{m.param_window()}</label>
						<input
							class={eingabeKlasse}
							id="zaehlerFensterSekunden"
							name="zaehlerFensterSekunden"
							type="number"
							min="1"
							step="1"
							value={aktuell.zaehlerFensterSekunden}
						/>
					</div>

					<div class="grid gap-4 sm:grid-cols-2">
						<div class={feldKlasse}>
							<label class={beschriftung} for="zaehlerUntergrenze">{m.param_lower()}</label>
							<input
								class={eingabeKlasse}
								id="zaehlerUntergrenze"
								name="zaehlerUntergrenze"
								type="number"
								min="0"
								step="1"
								value={aktuell.zaehlerUntergrenze}
							/>
						</div>
						<div class={feldKlasse}>
							<label class={beschriftung} for="zaehlerObergrenze">{m.param_upper()}</label>
							<input
								class={eingabeKlasse}
								id="zaehlerObergrenze"
								name="zaehlerObergrenze"
								type="number"
								min="0"
								step="1"
								value={aktuell.zaehlerObergrenze}
							/>
						</div>
					</div>
					<p class={hinweis}>{m.param_bounds_hint()}</p>
				{/if}

				<div class={feldKlasse}>
					<label class={beschriftung} for="entwarnungsStabilitaetSekunden">
						{m.rule_stability()}
					</label>
					<input
						class={eingabeKlasse}
						id="entwarnungsStabilitaetSekunden"
						name="entwarnungsStabilitaetSekunden"
						type="number"
						min="0"
						step="1"
						value={aktuell.entwarnungsStabilitaetSekunden}
					/>
					<p class={hinweis}>{m.rule_stability_hint()}</p>
				</div>
			</section>

			{#if belege.length > 0}
				<section class={abschnitt}>
					<h2 class="text-lg font-medium text-slate-100">{m.wizard_evidence()}</h2>
					<p class={hinweis}>{m.wizard_evidence_hint()}</p>
					<ul class="flex list-inside list-disc flex-col gap-1 text-sm text-slate-300">
						{#each belege as beleg, i (i)}
							<li>{belegText(beleg)}</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section class="{abschnitt} gap-3">
				<h2 class="text-lg font-medium text-slate-100">{m.wizard_confirm()}</h2>
				<p class={hinweis}>{m.wizard_confirm_hint()}</p>
				<div class="flex flex-wrap gap-3">
					<button
						type="submit"
						class={knopfStark}
						formaction={aktion('anlegen')}
						name="aktivieren"
						value="true"
					>
						{m.wizard_create_and_activate()}
					</button>
					<button
						type="submit"
						class={knopfKlasse}
						formaction={aktion('anlegen')}
						name="aktivieren"
						value="false"
					>
						{m.wizard_create_draft()}
					</button>
				</div>
			</section>
		{/if}

		<!-- Navigation ----------------------------------------------------------------------------- -->
		<nav class="flex items-center justify-between">
			{#if schritt > 1}
				<button
					type="submit"
					class={knopfKlasse}
					formaction={aktion('schritt')}
					name="ziel"
					value={schritt - 1}
				>
					{m.wizard_previous()}
				</button>
			{:else}
				<span></span>
			{/if}

			{#if schritt < 4}
				<button
					type="submit"
					class={knopfStark}
					formaction={aktion('schritt')}
					name="ziel"
					value={schritt + 1}
				>
					{m.wizard_next()}
				</button>
			{:else}
				<span></span>
			{/if}
		</nav>
	</form>
</main>
