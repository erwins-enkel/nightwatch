<script lang="ts">
	import { AlertTriangle, ArrowLeft, Building2, Trash2 } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { ZuordnungsStufe } from '$lib/server/db/schema/enums';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fehler = $derived(form?.fehler ?? {});
	const eingaben = $derived(form?.eingaben);
	const kunde = $derived(data.kunde);

	const FELD_FEHLER: Record<string, () => string> = {
		pflicht: m.error_required,
		autotask: m.error_autotask_id,
		plus_adresse: m.error_trait_plus_address,
		zu_kurz: m.error_trait_too_short,
		absender: m.error_trait_sender,
		doppelt: m.error_trait_duplicate,
		suche_kurz: m.error_search_too_short,
		suche: m.error_autotask_search,
		nicht_konfiguriert: m.customer_autotask_unconfigured
	};

	/** Declaration order = match order, so the picker lists the stages in their priority. */
	const STUFEN: { wert: ZuordnungsStufe; label: () => string; hinweis: () => string }[] = [
		{ wert: 'plus_adresse', label: m.stage_plus_adresse, hinweis: m.stage_plus_adresse_hint },
		{ wert: 'inhaltsmuster', label: m.stage_inhaltsmuster, hinweis: m.stage_inhaltsmuster_hint },
		{ wert: 'absender', label: m.stage_absender, hinweis: m.stage_absender_hint }
	];

	let gewaehlteStufe = $state<ZuordnungsStufe>('plus_adresse');
	const stufenHinweis = $derived(
		STUFEN.find((stufe) => stufe.wert === gewaehlteStufe)?.hinweis() ?? ''
	);

	function stufenLabel(wert: ZuordnungsStufe): string {
		return STUFEN.find((stufe) => stufe.wert === wert)?.label() ?? wert;
	}

	/**
	 * Deliberately not `toLocaleString()`: the page is server-rendered and then hydrated, and the
	 * container's locale and time zone are not the browser's — the two would render different text
	 * for the same instant and the hydration would mismatch.
	 */
	function zeitpunkt(wert: Date | string | null): string {
		if (!wert) return '—';
		return `${new Date(wert).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
	}

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';
</script>

<svelte:head><title>{kunde.name} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
	<header class="flex flex-col gap-3">
		<a
			href={resolve('/kunden')}
			class="flex w-fit items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
		>
			<ArrowLeft class="size-3" aria-hidden="true" />
			{m.customer_back()}
		</a>
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<Building2 class="size-6 text-emerald-400" aria-hidden="true" />
			{kunde.name}
			<span
				class="rounded-full px-2 py-1 text-xs font-normal {kunde.zustand === 'aktiv'
					? 'bg-emerald-950 text-emerald-300'
					: 'bg-slate-800 text-slate-400'}"
			>
				{kunde.zustand === 'aktiv' ? m.customer_state_active() : m.customer_state_archived()}
			</span>
		</h1>
		{#if kunde.archiviertAm}
			<p class="text-sm text-slate-400">
				{m.customer_archived_since()}: {zeitpunkt(kunde.archiviertAm)}
			</p>
		{/if}
	</header>

	{#if form?.erfolg === 'gespeichert'}
		<p
			class="rounded border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300"
			role="status"
		>
			{m.saved()}
		</p>
	{:else if form?.erfolg === 'merkmal'}
		<div
			class="flex flex-col gap-1 rounded border px-4 py-2 text-sm {form.kollisionen.length > 0
				? 'border-amber-800 bg-amber-950/40 text-amber-200'
				: 'border-emerald-800 bg-emerald-950/40 text-emerald-300'}"
			role="status"
		>
			<span>{m.trait_added()}</span>
			{#if form.kollisionen.length > 0}
				<span>{m.trait_collision()} {form.kollisionen.join(', ')}</span>
				<span class="text-amber-300/80">{m.trait_collision_hint()}</span>
			{/if}
		</div>
	{/if}

	{#if fehler.formular === 'historie'}
		<p class="rounded border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
			{m.customer_delete_blocked()}
		</p>
	{/if}

	<!-- Zuordnungs-Merkmale zuerst: ohne sie kann diesem Kunden keine Mail zugeordnet werden. -->
	<section class="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-medium text-slate-100">{m.traits_title()}</h2>
			<p class="max-w-2xl text-sm text-slate-400">{m.traits_intro()}</p>
		</div>

		<ul class="flex flex-col gap-2">
			{#each data.merkmale as merkmal (merkmal.id)}
				{@const kollisionen = data.kollisionen[merkmal.id] ?? []}
				<li
					class="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-800 p-3"
				>
					<div class="flex flex-col gap-1">
						<span class="text-xs text-slate-500">{stufenLabel(merkmal.stufe)}</span>
						<span class="font-mono text-sm text-slate-200">{merkmal.wert}</span>
						{#if kollisionen.length > 0}
							<span class="flex items-center gap-1 text-xs text-amber-300">
								<AlertTriangle class="size-3" aria-hidden="true" />
								{m.trait_collision()}
								{kollisionen
									.map((andere) =>
										andere.zustand === 'archiviert'
											? `${andere.name} (${m.customer_state_archived()})`
											: andere.name
									)
									.join(', ')}
							</span>
						{/if}
					</div>

					<form method="POST" action="?/merkmalEntfernen" use:enhance>
						<input type="hidden" name="id" value={merkmal.id} />
						<button
							type="submit"
							class="rounded border border-slate-700 px-3 py-1 text-xs text-rose-300 hover:border-rose-700"
						>
							{m.trait_remove()}
						</button>
					</form>
				</li>
			{:else}
				<li class="rounded border border-dashed border-slate-800 p-4 text-sm text-amber-300">
					{m.traits_empty()}
				</li>
			{/each}
		</ul>

		<form method="POST" action="?/merkmalAnlegen" use:enhance class="flex flex-col gap-3">
			<div class="flex flex-wrap items-start gap-3">
				<div class="flex flex-col gap-1">
					<label class="text-sm text-slate-300" for="stufe">{m.trait_stage()}</label>
					<select class={eingabeKlasse} id="stufe" name="stufe" bind:value={gewaehlteStufe}>
						{#each STUFEN as stufe (stufe.wert)}
							<option value={stufe.wert}>{stufe.label()}</option>
						{/each}
					</select>
				</div>

				<div class="flex min-w-64 flex-1 flex-col gap-1">
					<label class="text-sm text-slate-300" for="wert">{m.trait_value()}</label>
					<input
						class={eingabeKlasse}
						id="wert"
						name="wert"
						value={eingaben?.wert ?? ''}
						required
						aria-describedby="wert-hinweis"
						aria-invalid={fehler.wert ? 'true' : undefined}
					/>
					<p id="wert-hinweis" class="text-xs text-slate-500">{stufenHinweis}</p>
					{#if fehler.wert}
						<p class="text-xs text-rose-400">
							{FELD_FEHLER[fehler.wert]?.() ?? m.error_required()}
						</p>
					{/if}
				</div>
			</div>

			<button
				type="submit"
				class="w-fit rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
			>
				{m.trait_add()}
			</button>
		</form>
	</section>

	<section class="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<h2 class="mb-4 text-lg font-medium text-slate-100">{m.customer_master_data()}</h2>

		<form method="POST" action="?/stammdaten" use:enhance class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="name">{m.customer_name()}</label>
				<input
					class={eingabeKlasse}
					id="name"
					name="name"
					value={kunde.name}
					required
					aria-invalid={fehler.name ? 'true' : undefined}
				/>
				{#if fehler.name}
					<p class="text-xs text-rose-400">{FELD_FEHLER[fehler.name]?.() ?? m.error_required()}</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="kundennummer">{m.customer_number()}</label>
				<input
					class={eingabeKlasse}
					id="kundennummer"
					name="kundennummer"
					value={kunde.kundennummer ?? ''}
					aria-describedby="kundennummer-hinweis"
				/>
				<p id="kundennummer-hinweis" class="text-xs text-slate-500">{m.customer_number_hint()}</p>
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="notiz">{m.customer_note()}</label>
				<input class={eingabeKlasse} id="notiz" name="notiz" value={kunde.notiz ?? ''} />
			</div>

			<div class="sm:col-span-2">
				<button
					type="submit"
					class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
				>
					{m.customer_update()}
				</button>
			</div>
		</form>
	</section>

	<!-- CONTEXT „Autotask-Verknüpfung": per Suche gesetzt, gespeichert wird nur die Company-ID. -->
	<section class="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-medium text-slate-100">{m.customer_autotask()}</h2>
			<p class="max-w-2xl text-sm text-slate-400">{m.customer_autotask_hint()}</p>
		</div>

		{#if kunde.autotaskCompanyId !== null}
			<div
				class="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-800 p-3"
			>
				<div class="flex flex-col gap-1">
					<span class="text-sm text-slate-200">
						{data.companyName ?? m.customer_autotask_name_unknown()}
					</span>
					<span class="font-mono text-xs text-slate-500">
						{m.customer_autotask_company()}: {kunde.autotaskCompanyId}
					</span>
				</div>
				<form method="POST" action="?/autotaskLoesen" use:enhance>
					<button
						type="submit"
						class="rounded border border-slate-700 px-3 py-1 text-xs text-rose-300 hover:border-rose-700"
					>
						{m.customer_autotask_unlink()}
					</button>
				</form>
			</div>
		{:else}
			<p class="rounded border border-dashed border-slate-800 p-4 text-sm text-slate-400">
				{m.customer_autotask_none()}
			</p>
		{/if}

		{#if data.autotaskVerfuegbar}
			<form
				method="POST"
				action="?/autotaskSuchen"
				use:enhance
				class="flex flex-wrap items-end gap-3"
			>
				<div class="flex min-w-64 flex-1 flex-col gap-1">
					<label class="text-sm text-slate-300" for="suche">{m.customer_autotask_search()}</label>
					<input
						class={eingabeKlasse}
						id="suche"
						name="suche"
						value={form?.erfolg === 'gesucht' ? form.begriff : ''}
						aria-invalid={fehler.suche ? 'true' : undefined}
					/>
				</div>
				<button
					type="submit"
					class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
				>
					{m.customer_autotask_search_go()}
				</button>
			</form>

			{#if fehler.suche}
				<p class="text-xs text-rose-400">{FELD_FEHLER[fehler.suche]?.() ?? m.error_required()}</p>
			{/if}

			{#if form?.erfolg === 'gesucht'}
				<ul class="flex flex-col gap-2">
					{#each form.treffer as treffer (treffer.id)}
						<li
							class="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-800 p-3"
						>
							<div class="flex flex-col gap-1">
								<span class="text-sm text-slate-200">
									{treffer.name}
									{#if !treffer.aktiv}
										<span class="ml-2 text-xs text-amber-300">{m.customer_autotask_inactive()}</span
										>
									{/if}
								</span>
								<span class="font-mono text-xs text-slate-500">
									#{treffer.id}{treffer.ort ? ` · ${treffer.ort}` : ''}
								</span>
							</div>
							<form method="POST" action="?/autotaskVerknuepfen" use:enhance>
								<input type="hidden" name="companyId" value={treffer.id} />
								<button
									type="submit"
									class="rounded border border-slate-700 px-3 py-1 text-xs text-emerald-300 hover:border-emerald-700"
								>
									{m.customer_autotask_link()}
								</button>
							</form>
						</li>
					{:else}
						<li class="rounded border border-dashed border-slate-800 p-4 text-sm text-slate-400">
							{m.customer_autotask_no_hits()}
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="text-sm text-amber-300">{m.customer_autotask_unconfigured()}</p>
		{/if}
	</section>

	<section class="flex flex-wrap items-center gap-4 rounded-lg border border-slate-800 p-4">
		<form
			method="POST"
			action="?/zustand"
			use:enhance={({ cancel }) => {
				if (kunde.zustand === 'aktiv' && !confirm(m.customer_archive_confirm())) cancel();
			}}
		>
			<input type="hidden" name="archivieren" value={String(kunde.zustand === 'aktiv')} />
			<button
				type="submit"
				class="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500"
			>
				{kunde.zustand === 'aktiv' ? m.customer_archive() : m.customer_reactivate()}
			</button>
		</form>

		<div class="flex flex-1 flex-col gap-1">
			<form
				method="POST"
				action="?/loeschen"
				use:enhance={({ cancel }) => {
					if (!confirm(m.customer_delete_confirm())) cancel();
				}}
			>
				<button
					type="submit"
					disabled={kunde.hatHistorie}
					class="flex items-center gap-1 rounded border border-slate-700 px-3 py-1 text-sm text-rose-300 hover:border-rose-700 disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:border-slate-700"
				>
					<Trash2 class="size-3" aria-hidden="true" />
					{m.customer_delete()}
				</button>
			</form>
			<p class="text-xs text-slate-500">{m.customer_delete_hint()}</p>
		</div>
	</section>
</main>
