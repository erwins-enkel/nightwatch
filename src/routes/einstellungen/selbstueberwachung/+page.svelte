<script lang="ts">
	import { ArrowLeft, HeartPulse, ShieldAlert, ShieldCheck } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fehler = $derived(form?.fehler ?? {});
	const status = $derived(data.status);

	/**
	 * „Ohne konfigurierten Empfänger ist der Totalausfall unbeobachtet, und das Dashboard sagt das"
	 * (SPEC §8). Ein Webhook-Ziel deckt den Datenbank-Ausfall ab, der Ping den Totalausfall — fehlen
	 * beide, merkt niemand etwas, und genau das steht dann hier.
	 */
	const unbeobachtet = $derived(!status.heartbeatPingKonfiguriert && !status.webhookZielVorhanden);

	const FELD_FEHLER: Record<string, () => string> = {
		zahl: m.error_number,
		url: m.error_webhook_url,
		schema: m.error_webhook_scheme
	};

	function meldung(feld: string): string | undefined {
		const schluessel = fehler[feld];
		return schluessel ? (FELD_FEHLER[schluessel]?.() ?? m.error_required()) : undefined;
	}

	function zeitpunkt(wert: Date | string | null): string {
		if (wert === null) return '—';
		return new Date(wert).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
	}

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';

	const knopfKlasse =
		'w-fit rounded border border-emerald-700 px-4 py-2 text-sm text-emerald-300 hover:border-emerald-500';
</script>

<svelte:head><title>{m.self_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
	<header class="flex flex-col gap-3">
		<a
			href={resolve('/')}
			class="flex w-fit items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
		>
			<ArrowLeft class="size-3" aria-hidden="true" />
			{m.self_back()}
		</a>
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<ShieldCheck class="size-6 text-emerald-400" aria-hidden="true" />
			{m.self_title()}
		</h1>
		<p class="max-w-2xl text-sm text-slate-400">{m.self_intro()}</p>
		<p class="max-w-2xl text-sm text-slate-400">{m.self_existence_hint()}</p>
	</header>

	{#if form?.erfolg}
		<p
			class="rounded border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300"
			role="status"
		>
			{m.saved()}
		</p>
	{/if}

	{#if fehler.formular}
		<p class="rounded border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
			{m.self_save_failed()}
		</p>
	{/if}

	{#if unbeobachtet}
		<p
			class="flex items-start gap-2 rounded border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-200"
		>
			<ShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{m.self_unobserved()}
		</p>
	{/if}

	<!-- Dienste ------------------------------------------------------------------------------ -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lg font-medium text-slate-100">{m.self_services()}</h2>
		<p class="text-sm text-slate-400">{m.self_services_hint()}</p>
		<ul class="flex flex-wrap gap-3">
			{#each status.dienste as dienst (dienst.dienst)}
				<li class="rounded border border-slate-800 bg-slate-900/50 px-3 py-2 text-sm">
					<span class="text-slate-200">{dienst.dienst}</span>
					<span class="ml-2 text-xs text-slate-500">{zeitpunkt(dienst.zuletztGesehen)}</span>
				</li>
			{/each}
		</ul>
	</section>

	<!-- Selbst-Monitore ---------------------------------------------------------------------- -->
	<section class="flex flex-col gap-4">
		<h2 class="text-lg font-medium text-slate-100">{m.self_monitors()}</h2>

		{#each status.monitore as monitor (monitor.id)}
			<article class="rounded-lg border border-slate-800 bg-slate-900/50">
				<div class="flex flex-wrap items-start justify-between gap-4 p-4">
					<div class="flex flex-col gap-1">
						<h3 class="text-base font-medium text-slate-100">{monitor.bezeichnung}</h3>
						<p class="font-mono text-xs text-slate-500">{monitor.schluessel}</p>
					</div>
					<span
						class="rounded-full px-2 py-1 text-xs {monitor.zustand === 'gesund'
							? 'bg-emerald-950 text-emerald-300'
							: 'bg-rose-950 text-rose-300'}"
					>
						{monitor.zustand === 'gesund' ? m.self_healthy() : m.self_disturbed()}
						{#if monitor.alarmgrund}
							· {monitor.alarmgrund}
						{/if}
					</span>
				</div>

				<form
					method="POST"
					action="?/parameter"
					use:enhance
					class="grid gap-4 border-t border-slate-800 px-4 py-4 sm:grid-cols-3"
				>
					<input type="hidden" name="id" value={monitor.id} />

					<div class="flex flex-col gap-1">
						<label class="text-sm text-slate-300" for="{monitor.id}-staleness">
							{m.self_staleness()}
						</label>
						<input
							class={eingabeKlasse}
							id="{monitor.id}-staleness"
							name="stalenessSekunden"
							type="number"
							min="1"
							value={monitor.stalenessSekunden}
							required
							aria-describedby="{monitor.id}-staleness-hinweis"
						/>
						<p id="{monitor.id}-staleness-hinweis" class="text-xs text-slate-500">
							{m.self_staleness_hint()}
						</p>
						{#if meldung('stalenessSekunden')}
							<p class="text-xs text-rose-400">{meldung('stalenessSekunden')}</p>
						{/if}
					</div>

					<div class="flex flex-col gap-1">
						<label class="text-sm text-slate-300" for="{monitor.id}-stabilitaet">
							{m.self_stability()}
						</label>
						<input
							class={eingabeKlasse}
							id="{monitor.id}-stabilitaet"
							name="entwarnungsStabilitaetSekunden"
							type="number"
							min="0"
							value={monitor.entwarnungsStabilitaetSekunden ?? ''}
							aria-describedby="{monitor.id}-stabilitaet-hinweis"
						/>
						<p id="{monitor.id}-stabilitaet-hinweis" class="text-xs text-slate-500">
							{m.self_stability_hint()}
						</p>
						{#if meldung('entwarnungsStabilitaetSekunden')}
							<p class="text-xs text-rose-400">{meldung('entwarnungsStabilitaetSekunden')}</p>
						{/if}
					</div>

					<div class="flex items-end">
						<button type="submit" class={knopfKlasse}>{m.self_save_parameters()}</button>
					</div>
				</form>
			</article>
		{/each}
	</section>

	<!-- Heartbeat-Ping ----------------------------------------------------------------------- -->
	<section class="flex flex-col gap-4">
		<h2 class="flex items-center gap-2 text-lg font-medium text-slate-100">
			<HeartPulse class="size-5 text-emerald-400" aria-hidden="true" />
			{m.self_ping()}
		</h2>
		<p class="max-w-2xl text-sm text-slate-400">{m.self_ping_intro()}</p>

		<form method="POST" action="?/ping" use:enhance class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="ping-url">{m.self_ping_url()}</label>
				<!-- Bewusst ohne `value`: die URL trägt meist ein Token und wird verschlüsselt
				     gespeichert — sie geht nie an den Browser zurück (SPEC §12). -->
				<input
					class={eingabeKlasse}
					id="ping-url"
					name="url"
					type="url"
					placeholder="https://hc.example.com/ping/…"
					aria-describedby="ping-url-hinweis"
					aria-invalid={meldung('url') ? 'true' : undefined}
				/>
				<p id="ping-url-hinweis" class="text-xs text-slate-500">
					{status.heartbeatPingKonfiguriert ? m.self_ping_url_kept() : m.self_ping_url_hint()}
				</p>
				{#if meldung('url')}
					<p class="text-xs text-rose-400">{meldung('url')}</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-sm text-slate-300" for="ping-intervall">{m.self_ping_interval()}</label>
				<input
					class={eingabeKlasse}
					id="ping-intervall"
					name="intervallSekunden"
					type="number"
					min="1"
					value={status.heartbeatPingIntervallSekunden}
					required
					aria-describedby="ping-intervall-hinweis"
				/>
				<p id="ping-intervall-hinweis" class="text-xs text-slate-500">
					{m.self_ping_interval_hint()}
				</p>
				{#if meldung('intervallSekunden')}
					<p class="text-xs text-rose-400">{meldung('intervallSekunden')}</p>
				{/if}
			</div>

			<p class="text-sm text-slate-400 sm:col-span-2">
				{m.self_ping_last()}: {zeitpunkt(status.heartbeatPingZuletztAm)}
			</p>

			<div class="flex items-center gap-3 sm:col-span-2">
				<button type="submit" class={knopfKlasse}>{m.self_ping_save()}</button>
				{#if status.heartbeatPingKonfiguriert}
					<button
						type="submit"
						name="abschalten"
						value="true"
						class="w-fit rounded border border-slate-700 px-4 py-2 text-sm text-rose-300 hover:border-rose-700"
					>
						{m.self_ping_off()}
					</button>
				{/if}
			</div>
		</form>
	</section>
</main>
