<script lang="ts">
	import { Building2 } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fehler = $derived(form?.fehler ?? {});
	const eingaben = $derived(form?.eingaben);

	const FELD_FEHLER: Record<string, () => string> = {
		pflicht: m.error_required,
		autotask: m.error_autotask_id
	};

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';
</script>

<svelte:head><title>{m.customers_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
	<header class="flex flex-col gap-2">
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<Building2 class="size-6 text-emerald-400" aria-hidden="true" />
			{m.customers_title()}
		</h1>
		<p class="max-w-2xl text-sm text-slate-400">{m.customers_intro()}</p>
	</header>

	<section class="flex flex-col gap-3">
		{#each data.kunden as kunde (kunde.id)}
			<article
				class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4"
			>
				<div class="flex flex-col gap-1">
					<h2 class="text-lg font-medium text-slate-100">{kunde.name}</h2>
					<p class="text-sm text-slate-400">
						{#if kunde.kundennummer}
							<span class="font-mono">{kunde.kundennummer}</span> ·
						{/if}
						{m.customer_traits_count()}: {kunde.merkmale} · {m.customer_monitors_count()}:
						{kunde.monitore}
					</p>
				</div>

				<div class="flex items-center gap-3">
					<span
						class="rounded-full px-2 py-1 text-xs {kunde.zustand === 'aktiv'
							? 'bg-emerald-950 text-emerald-300'
							: 'bg-slate-800 text-slate-400'}"
					>
						{kunde.zustand === 'aktiv' ? m.customer_state_active() : m.customer_state_archived()}
					</span>
					<a
						href={resolve('/kunden/[id]', { id: kunde.id })}
						class="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
					>
						{m.customer_open()}
					</a>
				</div>
			</article>
		{:else}
			<p class="rounded-lg border border-dashed border-slate-800 p-6 text-sm text-slate-400">
				{m.customers_empty()}
			</p>
		{/each}
	</section>

	<section class="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<h2 class="mb-4 text-lg font-medium text-slate-100">{m.customer_add()}</h2>

		<form method="POST" action="?/anlegen" use:enhance class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="name">{m.customer_name()}</label>
				<input
					class={eingabeKlasse}
					id="name"
					name="name"
					value={eingaben?.name ?? ''}
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
					value={eingaben?.kundennummer ?? ''}
					aria-describedby="kundennummer-hinweis"
				/>
				<p id="kundennummer-hinweis" class="text-xs text-slate-500">{m.customer_number_hint()}</p>
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="autotaskCompanyId">{m.customer_autotask()}</label
				>
				<input
					class={eingabeKlasse}
					id="autotaskCompanyId"
					name="autotaskCompanyId"
					type="number"
					min="1"
					step="1"
					value={eingaben?.autotaskCompanyId ?? ''}
					aria-describedby="autotask-hinweis"
					aria-invalid={fehler.autotaskCompanyId ? 'true' : undefined}
				/>
				<p id="autotask-hinweis" class="text-xs text-slate-500">{m.customer_autotask_hint()}</p>
				{#if fehler.autotaskCompanyId}
					<p class="text-xs text-rose-400">{m.error_autotask_id()}</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="notiz">{m.customer_note()}</label>
				<input class={eingabeKlasse} id="notiz" name="notiz" value={eingaben?.notiz ?? ''} />
			</div>

			<div class="sm:col-span-2">
				<button
					type="submit"
					class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
				>
					{m.customer_save()}
				</button>
			</div>
		</form>
	</section>
</main>
