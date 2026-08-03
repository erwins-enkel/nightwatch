<script lang="ts">
	import { ArrowLeft, Download, LibraryBig, Trash2 } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fehler = $derived(form && 'fehler' in form ? (form.fehler as string[]) : []);

	const FEHLER: Record<string, () => string> = {
		leer: m.templates_error_empty,
		kein_json: m.templates_error_json,
		kein_objekt: m.templates_error_shape,
		format_unbekannt: m.templates_error_format,
		keine_vorlagen: m.templates_error_empty_list,
		schluessel_fehlt: m.templates_error_key_missing,
		schluessel_ungueltig: m.templates_error_key_invalid,
		schluessel_doppelt: m.templates_error_key_duplicate,
		name_fehlt: m.templates_error_name,
		version_ungueltig: m.templates_error_version,
		art_unbekannt: m.rule_error_kind,
		muster_ungueltig: m.rule_error_pattern,
		kein_match_kriterium: m.rule_error_no_criterion,
		parameter_ungueltig: m.templates_error_parameters,
		kuratiert: m.templates_error_curated,
		unbekannt: m.rule_error_gone,
		monitor_fehlt: m.templates_error_monitor,
		vorlage_ungueltig: m.templates_error_from_monitor,
		schluessel_kuratiert: m.templates_error_key_curated
	};

	/** „muster_ungueltig#2" — der Prüfer nennt den Eintrag, in dem der Fehler steckt. */
	function fehlerText(schluessel: string): string {
		const [name, eintrag] = schluessel.split('#');
		const text = FEHLER[name]?.() ?? name;
		return eintrag ? m.templates_error_entry({ nummer: eintrag, meldung: text }) : text;
	}

	const ART: Record<string, () => string> = {
		heartbeat: m.kind_heartbeat,
		ereignis: m.kind_event,
		paar: m.kind_pair,
		zaehler: m.kind_counter
	};

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';
	const feldKlasse = 'flex flex-col gap-1';
	const beschriftung = 'text-sm text-slate-300';
	const hinweis = 'text-xs text-slate-500';
	const abschnitt = 'flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4';
	const knopfKlasse =
		'w-fit rounded border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500';
</script>

<svelte:head><title>{m.templates_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
	<header class="flex flex-col gap-3">
		<a
			href={resolve('/')}
			class="flex w-fit items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
		>
			<ArrowLeft class="size-3" aria-hidden="true" />
			{m.templates_back()}
		</a>
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<LibraryBig class="size-6 text-emerald-400" aria-hidden="true" />
			{m.templates_title()}
		</h1>
		<p class="max-w-2xl text-sm text-slate-400">{m.templates_intro()}</p>
	</header>

	{#if form && 'erfolg' in form}
		<p
			class="rounded border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300"
			role="status"
		>
			{#if form.erfolg === 'importiert'}
				{m.templates_imported({ anzahl: form.geschrieben })}
				{#if form.abgelehnt.length > 0}
					{m.templates_rejected({ schluessel: form.abgelehnt.join(', ') })}
				{/if}
			{:else if form.erfolg === 'geloescht'}
				{m.templates_deleted()}
			{:else}
				{m.templates_created()}
			{/if}
		</p>
	{/if}

	{#if fehler.length > 0}
		<ul
			class="flex list-inside list-disc flex-col gap-1 rounded border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300"
		>
			{#each fehler as schluessel (schluessel)}
				<li>{fehlerText(schluessel)}</li>
			{/each}
		</ul>
	{/if}

	<!-- Bestand ------------------------------------------------------------------------------- -->
	<section class={abschnitt}>
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 class="text-lg font-medium text-slate-100">{m.templates_list()}</h2>
			<a
				class="flex items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
				href={resolve('/einstellungen/vorlagen/export')}
			>
				<Download class="size-3" aria-hidden="true" />
				{m.templates_export_own()}
			</a>
		</div>

		{#if data.vorlagen.length === 0}
			<p class={hinweis}>{m.templates_none()}</p>
		{:else}
			<ul class="flex flex-col divide-y divide-slate-800">
				{#each data.vorlagen as vorlage (vorlage.id)}
					<li class="flex flex-wrap items-start justify-between gap-3 py-3">
						<div class="flex min-w-0 flex-col gap-1">
							<p class="text-sm text-slate-100">
								{#if vorlage.hersteller}<span class="text-slate-400"
										>{vorlage.hersteller} —
									</span>{/if}{vorlage.name}
								<span
									class="ml-2 rounded border px-1.5 py-0.5 text-[11px] {vorlage.herkunft ===
									'kuratiert'
										? 'border-sky-800 text-sky-300'
										: 'border-slate-700 text-slate-400'}"
								>
									{vorlage.herkunft === 'kuratiert' ? m.templates_curated() : m.templates_own()}
								</span>
							</p>
							{#if vorlage.beschreibung}
								<p class="max-w-xl text-xs text-slate-400">{vorlage.beschreibung}</p>
							{/if}
							<p class={hinweis}>
								{vorlage.schluessel} · v{vorlage.version}{vorlage.vorgeschlageneArt
									? ` · ${ART[vorlage.vorgeschlageneArt]()}`
									: ''}
							</p>
						</div>

						<div class="flex shrink-0 items-center gap-3">
							<a
								class="text-sm text-emerald-400 underline underline-offset-4"
								href={resolve(`/monitore/neu?vorlage=${encodeURIComponent(vorlage.id)}`)}
							>
								{m.templates_use()}
							</a>
							<a
								class="text-sm text-slate-300 underline underline-offset-4"
								href={resolve(
									`/einstellungen/vorlagen/export?id=${encodeURIComponent(vorlage.id)}`
								)}
							>
								{m.templates_export()}
							</a>
							{#if vorlage.herkunft === 'eigen'}
								<form method="POST" action="?/loeschen" use:enhance>
									<input type="hidden" name="id" value={vorlage.id} />
									<button
										type="submit"
										class="flex items-center gap-1 text-sm text-rose-400 hover:text-rose-300"
									>
										<Trash2 class="size-3" aria-hidden="true" />
										{m.templates_delete()}
									</button>
								</form>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Aus einem Monitor ---------------------------------------------------------------------- -->
	<section class={abschnitt}>
		<h2 class="text-lg font-medium text-slate-100">{m.templates_from_monitor()}</h2>
		<p class={hinweis}>{m.templates_from_monitor_hint()}</p>

		{#if data.monitore.length === 0}
			<p class={hinweis}>{m.templates_no_monitors()}</p>
		{:else}
			<form method="POST" action="?/ausMonitor" use:enhance class="flex flex-col gap-4">
				<div class={feldKlasse}>
					<label class={beschriftung} for="monitorId">{m.templates_monitor()}</label>
					<select class={eingabeKlasse} id="monitorId" name="monitorId" required>
						{#each data.monitore as monitor (monitor.id)}
							<option value={monitor.id}>{monitor.kundeName} · {monitor.bezeichnung}</option>
						{/each}
					</select>
				</div>

				<div class="grid gap-4 sm:grid-cols-2">
					<div class={feldKlasse}>
						<label class={beschriftung} for="schluessel">{m.templates_key()}</label>
						<input
							class={eingabeKlasse}
							id="schluessel"
							name="schluessel"
							placeholder="veeam-eigener-report"
							pattern="[a-z0-9][a-z0-9\-]*"
							required
						/>
						<p class={hinweis}>{m.templates_key_hint()}</p>
					</div>
					<div class={feldKlasse}>
						<label class={beschriftung} for="name">{m.templates_name()}</label>
						<input class={eingabeKlasse} id="name" name="name" required />
					</div>
				</div>

				<div class={feldKlasse}>
					<label class={beschriftung} for="beschreibung">{m.templates_description()}</label>
					<input class={eingabeKlasse} id="beschreibung" name="beschreibung" />
				</div>

				<button type="submit" class={knopfKlasse}>{m.templates_create()}</button>
			</form>
		{/if}
	</section>

	<!-- Import ---------------------------------------------------------------------------------- -->
	<section class={abschnitt}>
		<h2 class="text-lg font-medium text-slate-100">{m.templates_import()}</h2>
		<p class={hinweis}>{m.templates_import_hint()}</p>

		<form
			method="POST"
			action="?/importieren"
			enctype="multipart/form-data"
			use:enhance
			class="flex flex-col gap-4"
		>
			<div class={feldKlasse}>
				<label class={beschriftung} for="datei">{m.templates_file()}</label>
				<input
					class="text-sm text-slate-300 file:mr-3 file:rounded file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-1.5 file:text-slate-200"
					id="datei"
					name="datei"
					type="file"
					accept="application/json,.json"
				/>
			</div>

			<div class={feldKlasse}>
				<label class={beschriftung} for="inhalt">{m.templates_paste()}</label>
				<textarea class="{eingabeKlasse} font-mono text-xs" id="inhalt" name="inhalt" rows="6"
				></textarea>
			</div>

			<button type="submit" class={knopfKlasse}>{m.templates_import_start()}</button>
		</form>
	</section>
</main>
