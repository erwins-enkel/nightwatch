<script lang="ts">
	import { ArrowLeft, KeyRound, Trash2, Webhook } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fehler = $derived(form?.fehler ?? {});
	const eingaben = $derived(form?.eingaben);
	/** Only the card that was being edited shows the rejected values again. */
	const bearbeitet = $derived(form && 'bearbeitet' in form ? form.bearbeitet : null);

	const FELD_FEHLER: Record<string, () => string> = {
		pflicht: m.error_required,
		url: m.error_webhook_url,
		https: m.error_webhook_https,
		schema: m.error_webhook_scheme
	};

	function meldung(feld: string): string | undefined {
		const schluessel = fehler[feld];
		return schluessel ? (FELD_FEHLER[schluessel]?.() ?? m.error_required()) : undefined;
	}

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';

	const knopfKlasse =
		'rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500';
</script>

{#snippet zielFelder(
	werte: { bezeichnung: string; url: string; httpErlaubt: boolean },
	praefix: string,
	zeigeFehler: boolean,
	secretGespeichert: boolean
)}
	<div class="flex flex-col gap-1">
		<label class="text-sm text-slate-300" for="{praefix}-bezeichnung">{m.webhook_label()}</label>
		<input
			class={eingabeKlasse}
			id="{praefix}-bezeichnung"
			name="bezeichnung"
			type="text"
			value={werte.bezeichnung}
			required
			aria-invalid={zeigeFehler && meldung('bezeichnung') ? 'true' : undefined}
		/>
		{#if zeigeFehler && meldung('bezeichnung')}
			<p class="text-xs text-rose-400">{meldung('bezeichnung')}</p>
		{/if}
	</div>

	<div class="flex flex-col gap-1">
		<label class="text-sm text-slate-300" for="{praefix}-url">{m.webhook_url()}</label>
		<input
			class={eingabeKlasse}
			id="{praefix}-url"
			name="url"
			type="url"
			value={werte.url}
			placeholder="https://rmm.example.com/hooks/nightwatch"
			required
			aria-describedby="{praefix}-url-hinweis"
			aria-invalid={zeigeFehler && meldung('url') ? 'true' : undefined}
		/>
		<p id="{praefix}-url-hinweis" class="text-xs text-slate-500">{m.webhook_url_hint()}</p>
		{#if zeigeFehler && meldung('url')}
			<p class="text-xs text-rose-400">{meldung('url')}</p>
		{/if}
	</div>

	<div class="flex flex-col gap-1">
		<label class="flex items-center gap-2 text-sm text-slate-300">
			<input type="checkbox" name="httpErlaubt" value="true" checked={werte.httpErlaubt} />
			{m.webhook_http_optin()}
		</label>
		<p class="text-xs text-slate-500">{m.webhook_http_optin_hint()}</p>
	</div>

	<!-- Bewusst ohne `value`: ein Secret wird nie an den Browser zurückgegeben (SPEC §12). -->
	<div class="flex flex-col gap-1">
		<label class="text-sm text-slate-300" for="{praefix}-secret">{m.webhook_secret()}</label>
		<input
			class={eingabeKlasse}
			id="{praefix}-secret"
			name="secret"
			type="password"
			autocomplete="new-password"
			required={!secretGespeichert}
			aria-describedby="{praefix}-secret-hinweis"
			aria-invalid={zeigeFehler && meldung('secret') ? 'true' : undefined}
		/>
		<p id="{praefix}-secret-hinweis" class="text-xs text-slate-500">
			{secretGespeichert ? m.webhook_secret_kept() : m.webhook_secret_hint()}
		</p>
		{#if zeigeFehler && meldung('secret')}
			<p class="text-xs text-rose-400">{meldung('secret')}</p>
		{/if}
	</div>
{/snippet}

<svelte:head><title>{m.webhooks_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
	<header class="flex flex-col gap-3">
		<a
			href={resolve('/')}
			class="flex w-fit items-center gap-1 text-sm text-emerald-400 underline underline-offset-4"
		>
			<ArrowLeft class="size-3" aria-hidden="true" />
			{m.webhooks_back()}
		</a>
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<Webhook class="size-6 text-emerald-400" aria-hidden="true" />
			{m.webhooks_title()}
		</h1>
		<p class="max-w-2xl text-sm text-slate-400">{m.webhooks_intro()}</p>
		<p class="max-w-2xl text-sm text-slate-400">{m.webhooks_signature_hint()}</p>
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
			{fehler.formular === 'in_benutzung' ? m.webhook_remove_blocked() : m.webhook_save_failed()}
		</p>
	{/if}

	<section class="flex flex-col gap-4">
		{#each data.ziele as ziel (ziel.id)}
			<article class="rounded-lg border border-slate-800 bg-slate-900/50">
				<div class="flex flex-wrap items-start justify-between gap-4 p-4">
					<div class="flex flex-col gap-1">
						<h2 class="text-lg font-medium text-slate-100">{ziel.bezeichnung}</h2>
						<p class="font-mono text-sm break-all text-slate-400">{ziel.url}</p>
						<p class="flex items-center gap-1 text-xs text-slate-500">
							<KeyRound class="size-3" aria-hidden="true" />
							{ziel.secretGespeichert ? m.webhook_secret_present() : m.webhook_secret_missing()}
						</p>
					</div>

					<div class="flex items-center gap-2">
						<span
							class="rounded-full px-2 py-1 text-xs {ziel.aktiv
								? 'bg-emerald-950 text-emerald-300'
								: 'bg-slate-800 text-slate-400'}"
						>
							{ziel.aktiv ? m.webhook_active() : m.webhook_paused()}
						</span>

						<form method="POST" action="?/umschalten" use:enhance>
							<input type="hidden" name="id" value={ziel.id} />
							<input type="hidden" name="aktiv" value={String(!ziel.aktiv)} />
							<button type="submit" class={knopfKlasse}>
								{ziel.aktiv ? m.webhook_pause() : m.webhook_resume()}
							</button>
						</form>

						<form
							method="POST"
							action="?/entfernen"
							use:enhance={({ cancel }) => {
								if (!confirm(m.webhook_remove_confirm())) cancel();
							}}
						>
							<input type="hidden" name="id" value={ziel.id} />
							<button
								type="submit"
								class="flex items-center gap-1 rounded border border-slate-700 px-3 py-1 text-xs text-rose-300 hover:border-rose-700"
							>
								<Trash2 class="size-3" aria-hidden="true" />
								{m.webhook_remove()}
							</button>
						</form>
					</div>
				</div>

				<details class="border-t border-slate-800" open={bearbeitet === ziel.id}>
					<summary class="cursor-pointer px-4 py-3 text-sm text-emerald-400">
						{m.webhook_edit()}
					</summary>
					<form
						method="POST"
						action="?/bearbeiten"
						use:enhance
						class="grid gap-4 px-4 pb-4 sm:grid-cols-2"
					>
						<input type="hidden" name="id" value={ziel.id} />
						{@render zielFelder(
							bearbeitet === ziel.id && eingaben ? eingaben : ziel,
							ziel.id,
							bearbeitet === ziel.id,
							ziel.secretGespeichert
						)}
						<div class="sm:col-span-2">
							<button
								type="submit"
								class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
							>
								{m.webhook_save()}
							</button>
						</div>
					</form>
				</details>
			</article>
		{:else}
			<p class="rounded-lg border border-dashed border-slate-800 p-6 text-sm text-slate-400">
				{m.webhooks_empty()}
			</p>
		{/each}
	</section>

	<section class="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<h2 class="mb-4 text-lg font-medium text-slate-100">{m.webhook_add()}</h2>

		<form method="POST" action="?/anlegen" use:enhance class="grid gap-4 sm:grid-cols-2">
			{@render zielFelder(
				bearbeitet === null && eingaben
					? eingaben
					: { bezeichnung: '', url: '', httpErlaubt: false },
				'neu',
				bearbeitet === null,
				false
			)}
			<div class="sm:col-span-2">
				<button
					type="submit"
					class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
				>
					{m.webhook_save()}
				</button>
			</div>
		</form>
	</section>
</main>
