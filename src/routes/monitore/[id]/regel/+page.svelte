<script lang="ts">
	import { ArrowLeft, SquarePen } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const monitor = $derived(data.monitor);
	const eingaben = $derived(form?.eingaben);
	const fehler = $derived(form?.fehler ?? []);

	/** Der eingetippte Wert gewinnt über den gespeicherten — sonst frisst ein Fehlschlag die Eingabe. */
	function wert(
		feld: keyof NonNullable<typeof eingaben>,
		standard: string | number | null
	): string {
		const eingetippt = eingaben?.[feld];
		if (typeof eingetippt === 'string') return eingetippt;
		return standard === null ? '' : String(standard);
	}

	function liste(feld: keyof NonNullable<typeof eingaben>, standard: readonly string[]): string {
		const eingetippt = eingaben?.[feld];
		return typeof eingetippt === 'string' ? eingetippt : standard.join('\n');
	}

	/**
	 * Die Art steuert, welche Parameter überhaupt gelten (der Dreiklang-Vertrag, CONTEXT).
	 *
	 * Direkt initialisiert, nicht über einen Effekt: Effekte laufen beim Server-Rendern nicht, und
	 * ein leerer Startwert ließe die Seite ohne JavaScript die Parameter der falschen Art zeigen.
	 * Ein Effekt bräuchte es ohnehin nicht — nach einem abgelehnten Speichern bleibt die Komponente
	 * stehen, und die getroffene Wahl steht schon hier drin.
	 */
	// svelte-ignore state_referenced_locally
	let art = $state(wert('art', data.monitor.art));
	// svelte-ignore state_referenced_locally
	let modus = $state(wert('erwartungModus', data.monitor.erwartungModus));

	const FEHLER: Record<string, () => string> = {
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

	const gewaehlteTage = $derived(
		new Set(
			eingaben?.wochentage
				? eingaben.wochentage.map(Number)
				: (monitor.erwartungPlan?.wochentage ?? [])
		)
	);

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';
	const feldKlasse = 'flex flex-col gap-1';
	const beschriftung = 'text-sm text-slate-300';
	const hinweis = 'text-xs text-slate-500';
	const abschnitt = 'flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4';
</script>

<svelte:head><title>{m.rule_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
	<header class="flex flex-col gap-3">
		<a
			href={resolve(`/?monitor=${encodeURIComponent(monitor.id)}`)}
			class="flex w-fit items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
		>
			<ArrowLeft class="size-3" aria-hidden="true" />
			{m.rule_back()}
		</a>
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<SquarePen class="size-6 text-emerald-400" aria-hidden="true" />
			{m.rule_title()}
		</h1>
		<p class="text-sm text-slate-400">
			<b class="text-slate-200">{monitor.bezeichnung}</b> · {monitor.kundeName}
		</p>
		<p class="max-w-2xl text-sm text-slate-400">{m.rule_intro()}</p>
	</header>

	{#if form?.erfolg === 'gespeichert'}
		<p
			class="rounded border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300"
			role="status"
		>
			{m.saved()}
		</p>
	{/if}

	{#if fehler.length > 0}
		<ul
			class="flex list-inside list-disc flex-col gap-1 rounded border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300"
		>
			{#each fehler as schluessel (schluessel)}
				<li>{FEHLER[schluessel]?.() ?? schluessel}</li>
			{/each}
		</ul>
	{/if}

	<!-- Aktivierungs-Gate ------------------------------------------------------------------- -->
	<section class="{abschnitt} gap-3">
		<h2 class="text-lg font-medium text-slate-100">{m.rule_activation()}</h2>
		{#if monitor.aktiviertAm === null}
			<p class={hinweis}>{m.rule_activation_draft()}</p>
		{:else}
			<p class={hinweis}>{m.rule_activation_active()}</p>
		{/if}
		<form method="POST" action="?/aktivierung" use:enhance>
			<input type="hidden" name="aktiv" value={monitor.aktiviertAm === null ? 'true' : 'false'} />
			<button
				type="submit"
				class="w-fit rounded border border-emerald-700 px-4 py-2 text-sm text-emerald-300 hover:border-emerald-500"
			>
				{monitor.aktiviertAm === null ? m.rule_activate() : m.rule_deactivate()}
			</button>
		</form>
	</section>

	<form method="POST" action="?/speichern" use:enhance class="flex flex-col gap-6">
		<!-- Grunddaten ----------------------------------------------------------------------- -->
		<section class={abschnitt}>
			<h2 class="text-lg font-medium text-slate-100">{m.rule_basics()}</h2>

			<div class={feldKlasse}>
				<label class={beschriftung} for="bezeichnung">{m.rule_name()}</label>
				<input
					class={eingabeKlasse}
					id="bezeichnung"
					name="bezeichnung"
					value={wert('bezeichnung', monitor.bezeichnung)}
					required
				/>
			</div>

			<div class={feldKlasse}>
				<label class={beschriftung} for="art">{m.rule_kind()}</label>
				<select class={eingabeKlasse} id="art" name="art" bind:value={art}>
					{#each data.arten as wahl (wahl)}
						<option value={wahl}>{ART[wahl]()}</option>
					{/each}
				</select>
				<p class={hinweis}>{m.rule_kind_hint()}</p>
			</div>

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
					value={wert('entwarnungsStabilitaetSekunden', monitor.entwarnungsStabilitaetSekunden)}
				/>
				<p class={hinweis}>{m.rule_stability_hint()}</p>
			</div>
		</section>

		<!-- Erkennung ------------------------------------------------------------------------ -->
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
					value={liste('absender', monitor.regelAbsender)}></textarea>
			</div>

			<div class={feldKlasse}>
				<label class={beschriftung} for="betreffMuster">{m.rule_subject()}</label>
				<textarea
					class={eingabeKlasse}
					id="betreffMuster"
					name="betreffMuster"
					rows="2"
					value={liste('betreffMuster', monitor.regelBetreffMuster)}></textarea>
			</div>

			<div class={feldKlasse}>
				<label class={beschriftung} for="schluesselwoerter">{m.rule_keywords()}</label>
				<textarea
					class={eingabeKlasse}
					id="schluesselwoerter"
					name="schluesselwoerter"
					rows="2"
					value={liste('schluesselwoerter', monitor.regelSchluesselwoerter)}></textarea>
			</div>
		</section>

		<!-- Muster-Slots --------------------------------------------------------------------- -->
		{#if art !== 'zaehler'}
			<section class={abschnitt}>
				<h2 class="text-lg font-medium text-slate-100">{m.rule_slots()}</h2>
				<p class={hinweis}>{m.rule_slots_hint()}</p>

				{#if art !== 'ereignis'}
					<div class={feldKlasse}>
						<label class={beschriftung} for="musterSchlecht">
							{art === 'paar' ? m.slot_open() : m.slot_error()}
						</label>
						<textarea
							class={eingabeKlasse}
							id="musterSchlecht"
							name="musterSchlecht"
							rows="2"
							value={liste('musterSchlecht', monitor.regelMusterSchlecht)}></textarea>
					</div>
				{/if}

				<div class={feldKlasse}>
					<label class={beschriftung} for="musterGut">
						{art === 'paar' ? m.slot_close() : art === 'ereignis' ? m.slot_harmless() : m.slot_ok()}
					</label>
					<textarea
						class={eingabeKlasse}
						id="musterGut"
						name="musterGut"
						rows="2"
						value={liste('musterGut', monitor.regelMusterGut)}></textarea>
				</div>
			</section>
		{/if}

		<!-- Parameter je Art ----------------------------------------------------------------- -->
		<section class={abschnitt}>
			<h2 class="text-lg font-medium text-slate-100">{m.rule_parameters()}</h2>

			{#if art === 'heartbeat'}
				<fieldset class={feldKlasse}>
					<legend class={beschriftung}>{m.param_expectation()}</legend>
					<label class="flex items-center gap-2 text-sm text-slate-300">
						<input
							type="radio"
							name="erwartungModus"
							value="intervall"
							bind:group={modus}
							class="accent-emerald-500"
						/>
						{m.param_mode_interval()}
					</label>
					<label class="flex items-center gap-2 text-sm text-slate-300">
						<input
							type="radio"
							name="erwartungModus"
							value="kalenderplan"
							bind:group={modus}
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
							value={wert('uhrzeit', monitor.erwartungPlan?.uhrzeit ?? null)}
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
							value={wert('erwartungIntervallSekunden', monitor.erwartungIntervallSekunden)}
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
						value={wert('karenzSekunden', monitor.karenzSekunden)}
					/>
					<p class={hinweis}>{m.param_grace_hint()}</p>
				</div>
			{:else if art === 'ereignis'}
				<div class={feldKlasse}>
					<label class={beschriftung} for="autoZurueckSekunden">{m.param_auto_back()}</label>
					<input
						class={eingabeKlasse}
						id="autoZurueckSekunden"
						name="autoZurueckSekunden"
						type="number"
						min="1"
						step="1"
						value={wert('autoZurueckSekunden', monitor.autoZurueckSekunden)}
					/>
					<p class={hinweis}>{m.param_auto_back_hint()}</p>
				</div>
			{:else if art === 'paar'}
				<div class={feldKlasse}>
					<label class={beschriftung} for="maxOffenzeitSekunden">{m.param_max_open()}</label>
					<input
						class={eingabeKlasse}
						id="maxOffenzeitSekunden"
						name="maxOffenzeitSekunden"
						type="number"
						min="0"
						step="1"
						value={wert('maxOffenzeitSekunden', monitor.maxOffenzeitSekunden)}
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
						value={wert('zaehlerFensterSekunden', monitor.zaehlerFensterSekunden)}
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
							value={wert('zaehlerUntergrenze', monitor.zaehlerUntergrenze)}
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
							value={wert('zaehlerObergrenze', monitor.zaehlerObergrenze)}
						/>
					</div>
				</div>
				<p class={hinweis}>{m.param_bounds_hint()}</p>
			{/if}
		</section>

		<button
			type="submit"
			class="w-fit rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
		>
			{m.rule_save()}
		</button>
	</form>
</main>
