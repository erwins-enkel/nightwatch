<script lang="ts">
	import { AlertTriangle, ArrowLeft, CheckCircle2, Ticket } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PicklistWert } from '$lib/server/autotask/felder';
	import { m } from '$lib/paraglide/messages.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fehler = $derived(form?.fehler ?? {});

	const FELD_FEHLER: Record<string, () => string> = {
		pflicht: m.error_required,
		zahl: m.error_autotask_id
	};

	/**
	 * The eight tenant-specific values. Each one renders as a picklist when Autotask could be
	 * reached, and as a plain number field otherwise — the form must stay usable exactly when the
	 * connection is broken, because that is when it has to be fixed.
	 */
	const FELDER = $derived([
		{
			name: 'statusId',
			label: m.autotask_status(),
			hinweis: m.autotask_status_hint(),
			werte: data.picklisten?.status ?? null,
			wert: data.defaults.statusId
		},
		{
			name: 'priorityId',
			label: m.autotask_priority(),
			hinweis: m.autotask_priority_hint(),
			werte: data.picklisten?.prioritaet ?? null,
			wert: data.defaults.priorityId
		},
		{
			name: 'queueId',
			label: m.autotask_queue(),
			hinweis: m.autotask_queue_hint(),
			werte: data.picklisten?.queue ?? null,
			wert: data.defaults.queueId
		},
		{
			name: 'abschlussStatusId',
			label: m.autotask_close_status(),
			hinweis: m.autotask_close_status_hint(),
			werte: data.picklisten?.status ?? null,
			wert: data.defaults.abschlussStatusId
		},
		{
			name: 'arbeitstypId',
			label: m.autotask_work_type(),
			hinweis: m.autotask_work_type_hint(),
			werte: data.picklisten?.arbeitstyp ?? null,
			wert: data.defaults.arbeitstypId
		},
		{
			name: 'notizTypId',
			label: m.autotask_note_type(),
			hinweis: m.autotask_note_type_hint(),
			werte: data.picklisten?.notizTyp ?? null,
			wert: data.defaults.notizTypId
		},
		{
			name: 'notizPublishId',
			label: m.autotask_note_publish(),
			hinweis: m.autotask_note_publish_hint(),
			werte: data.picklisten?.notizPublish ?? null,
			wert: data.defaults.notizPublishId
		},
		{
			name: 'faelligkeitStunden',
			label: m.autotask_due_hours(),
			hinweis: m.autotask_due_hours_hint(),
			werte: null as PicklistWert[] | null,
			wert: data.defaults.faelligkeitStunden
		}
	]);

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';
</script>

<svelte:head><title>{m.autotask_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
	<header class="flex flex-col gap-3">
		<a
			href={resolve('/')}
			class="flex w-fit items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
		>
			<ArrowLeft class="size-3" aria-hidden="true" />
			{m.autotask_back()}
		</a>
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<Ticket class="size-6 text-emerald-400" aria-hidden="true" />
			{m.autotask_title()}
		</h1>
		<p class="max-w-2xl text-sm text-slate-400">{m.autotask_intro()}</p>
	</header>

	{#if form?.erfolg}
		<p
			class="rounded border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300"
			role="status"
		>
			{form.erfolg === 'zone' ? m.autotask_zone_resolved() : m.saved()}
		</p>
	{/if}

	{#if fehler.formular}
		<p class="rounded border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
			{fehler.formular === 'zone'
				? m.autotask_zone_failed()
				: fehler.formular === 'zone_ohne_benutzer'
					? m.autotask_zone_needs_user()
					: m.autotask_save_failed()}
		</p>
	{/if}

	<section class="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-medium text-slate-100">{m.autotask_access()}</h2>
			<p class="max-w-2xl text-sm text-slate-400">{m.autotask_access_hint()}</p>
		</div>

		<form method="POST" action="?/zugang" use:enhance class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="benutzer">{m.autotask_user()}</label>
				<input
					class={eingabeKlasse}
					id="benutzer"
					name="benutzer"
					value={form?.eingaben?.benutzer ?? data.benutzer ?? ''}
					aria-describedby="benutzer-hinweis"
					aria-invalid={fehler.benutzer ? 'true' : undefined}
				/>
				<p id="benutzer-hinweis" class="text-xs text-slate-500">{m.autotask_user_hint()}</p>
				{#if fehler.benutzer}
					<p class="text-xs text-rose-400">{FELD_FEHLER[fehler.benutzer]?.() ?? ''}</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="secret">{m.autotask_secret()}</label>
				<input
					class={eingabeKlasse}
					id="secret"
					name="secret"
					type="password"
					autocomplete="off"
					placeholder={data.secretGespeichert ? m.autotask_secret_kept() : ''}
					aria-describedby="secret-hinweis"
					aria-invalid={fehler.secret ? 'true' : undefined}
				/>
				<p id="secret-hinweis" class="text-xs text-slate-500">{m.autotask_secret_hint()}</p>
				{#if fehler.secret}
					<p class="text-xs text-rose-400">{FELD_FEHLER[fehler.secret]?.() ?? ''}</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="integrationCode">{m.autotask_code()}</label>
				<input
					class={eingabeKlasse}
					id="integrationCode"
					name="integrationCode"
					type="password"
					autocomplete="off"
					placeholder={data.integrationCodeGespeichert ? m.autotask_secret_kept() : ''}
					aria-describedby="code-hinweis"
					aria-invalid={fehler.integrationCode ? 'true' : undefined}
				/>
				<p id="code-hinweis" class="text-xs text-slate-500">{m.autotask_code_hint()}</p>
				{#if fehler.integrationCode}
					<p class="text-xs text-rose-400">{FELD_FEHLER[fehler.integrationCode]?.() ?? ''}</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<span class="text-sm text-slate-300">{m.autotask_channel()}</span>
				<label class="flex items-center gap-2 py-2 text-sm text-slate-300">
					<input type="checkbox" name="aktiv" value="true" checked={data.aktiv} class="size-4" />
					{m.autotask_channel_on()}
				</label>
				<p class="text-xs text-slate-500">{m.autotask_channel_hint()}</p>
			</div>

			<div class="sm:col-span-2">
				<button
					type="submit"
					class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
				>
					{m.autotask_save_access()}
				</button>
			</div>
		</form>
	</section>

	<section class="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-medium text-slate-100">{m.autotask_zone()}</h2>
			<p class="max-w-2xl text-sm text-slate-400">{m.autotask_zone_hint()}</p>
		</div>

		<p class="font-mono text-sm text-slate-200">{data.zoneUrl ?? m.autotask_zone_missing()}</p>

		<form method="POST" action="?/zone" use:enhance>
			<button
				type="submit"
				class="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500"
			>
				{m.autotask_zone_resolve()}
			</button>
		</form>

		<p
			class="flex items-center gap-2 text-sm {data.einsatzbereit
				? 'text-emerald-300'
				: 'text-amber-300'}"
		>
			{#if data.einsatzbereit}
				<CheckCircle2 class="size-4" aria-hidden="true" />
				{m.autotask_ready()}
			{:else}
				<AlertTriangle class="size-4" aria-hidden="true" />
				{m.autotask_not_ready()}
			{/if}
		</p>
	</section>

	<section class="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-medium text-slate-100">{m.autotask_defaults()}</h2>
			<p class="max-w-2xl text-sm text-slate-400">{m.autotask_defaults_hint()}</p>
		</div>

		{#if data.picklistenFehler}
			<p class="rounded border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
				{m.autotask_picklists_failed()}
			</p>
		{/if}

		<form method="POST" action="?/vorgaben" use:enhance class="grid gap-4 sm:grid-cols-2">
			{#each FELDER as feld (feld.name)}
				<div class="flex flex-col gap-1">
					<label class="text-sm text-slate-300" for={feld.name}>{feld.label}</label>
					{#if feld.werte && feld.werte.length > 0}
						<select class={eingabeKlasse} id={feld.name} name={feld.name} value={feld.wert ?? ''}>
							<option value="">{m.autotask_unset()}</option>
							{#each feld.werte as wert (wert.wert)}
								<option value={wert.wert}>{wert.label}</option>
							{/each}
						</select>
					{:else}
						<input
							class={eingabeKlasse}
							id={feld.name}
							name={feld.name}
							type="number"
							min="1"
							step="1"
							value={feld.wert ?? ''}
							aria-invalid={fehler[feld.name] ? 'true' : undefined}
						/>
					{/if}
					<p class="text-xs text-slate-500">{feld.hinweis}</p>
					{#if fehler[feld.name]}
						<p class="text-xs text-rose-400">{FELD_FEHLER[fehler[feld.name]]?.() ?? ''}</p>
					{/if}
				</div>
			{/each}

			<div class="sm:col-span-2">
				<button
					type="submit"
					class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
				>
					{m.autotask_save_defaults()}
				</button>
			</div>
		</form>
	</section>
</main>
