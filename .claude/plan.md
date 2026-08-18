# Plan: Exhausted-Account One-Shot Retry + API Key Column in UI

## Ringkasan perilaku yang diinginkan

1. **Exhausted retry sekali per refresh**: Saat aplikasi proxy baru start (PID baru) ATAU cache akun di-invalidate, akun ber-status `exhausted` **boleh dipilih satu kali** sebagai fallback saat tidak ada akun `active` tersisa. Jika saat dicoba request-nya **sukses** → status di-flip jadi `active`. Jika **gagal/masih exhausted** → di-skip untuk request-request berikutnya sampai refresh berikutnya (pakai in-memory flag, bukan quota tracker).
2. **Jangan pakai quota tracker**: Update status `exhausted → active` dipicu oleh **hasil request aktual** (sukses/gagal), BUKAN oleh `decrementQuota` / `quotaRemaining` tracking. Quota tracker tetap jalan untuk keperluan statistik, tapi tidak menjadi mekanisme reaktivasi.
3. **Tampilkan API key di UI**: Di tabel `AccountList` dan `ByokAccountList`, tampilkan kolom API key (untuk akun yang didaftarkan pakai api key = BYOK). Masked (`••••`) dengan eye-icon untuk reveal, mengikuti pola `revealByokKey` yang sudah ada. Akun non-BYOK (tidak punya api key) → kolom kosong/dash.

---

## Bagian 1: Exhausted One-Shot Retry (backend, `src/proxy/`)

### 1.1 — In-memory flag di `AccountPool` (`src/proxy/pool.ts`)

Tambahkan Set in-memory per-provider yang melacak akun exhausted yang **sudah dicoba di siklus ini**:

```ts
// di class AccountPool, dekat field lain (line ~27)
private exhaustedTriedByProvider = new Map<ProviderName, Set<number>>();
```

**Reset flag saat refresh** — di method `invalidate()` (line 38) dan saat pool init/start. Karena `invalidate()` sudah dipanggil di banyak tempat saat status berubah, ini cocok sebagai pemicu reset.

Tambahkan di `invalidate()`:
```ts
invalidate(provider?: ProviderName): void {
  if (provider) {
    this.activeAccountsCache.delete(provider);
    this.exhaustedTriedByProvider.delete(provider);  // RESET
    return;
  }
  this.activeAccountsCache.clear();
  this.exhaustedTriedByProvider.clear();  // RESET
}
```

### 1.2 — Method baru: `getExhaustedFallbackAccount` (`src/proxy/pool.ts`)

Method yang mencari akun `exhausted` (enabled=true) yang **belum dicoba di siklus ini**:

```ts
async getExhaustedFallbackAccount(provider: ProviderName): Promise<Account | null> {
  const tried = this.exhaustedTriedByProvider.get(provider) || new Set<number>();
  const rows = await db.select().from(accounts).where(
    and(
      eq(accounts.provider, provider),
      eq(accounts.status, "exhausted"),
      eq(accounts.enabled, true),
    )
  );
  // Pilih yang belum dicoba — round robin by lowest id for determinism
  const candidate = rows.find(r => !tried.has(r.id));
  return candidate || null;
}
```

### 1.3 — Method baru: `markExhaustedTried` & `markActiveFromExhausted` (`src/proxy/pool.ts`)

```ts
markExhaustedTried(provider: ProviderName, accountId: number): void {
  const tried = this.exhaustedTriedByProvider.get(provider) || new Set<number>();
  tried.add(accountId);
  this.exhaustedTriedByProvider.set(provider, tried);
}

async markActiveFromExhausted(accountId: number): Promise<void> {
  // Flip exhausted → active berdasarkan HASIL REQUEST SUKSES (bukan quota tracker)
  const [account] = await db.update(accounts).set({
    status: "active",
    errorMessage: null,
    updatedAt: new Date(),
  }).where(eq(accounts.id, accountId)).returning();
  if (account) {
    this.invalidate(account.provider as ProviderName);  // refresh cache + reset tried
    broadcast({ type: "account_status", data: { id: accountId, status: "active", provider: account.provider, reactivated: true } });
  }
}
```

Catatan: `invalidate` di sini akan reset `exhaustedTriedByProvider` — tapi karena akun ini sudah jadi `active`, ia masuk pool normal. Aman.

### 1.4 — Modifikasi `routeRequest` di `src/proxy/router.ts`

Di blok retry (line 140-152), saat `getNextAccount` return null (tidak ada active), **jangan langsung throw**. Coba exhausted fallback dulu:

```ts
for (let attempt = 0; attempt < maxRetries; attempt++) {
  let account = providerName === "byok"
    ? (await pool.getAccountForModel(...))?.account ?? null
    : await pool.getNextAccount(providerName);

  // NEW: fallback ke exhausted (one-shot per refresh)
  if (!account) {
    const exhausted = await pool.getExhaustedFallbackAccount(providerName);
    if (exhausted) {
      pool.markExhaustedTried(providerName, exhausted.id);
      account = exhausted;
    }
  }

  if (!account) {
    throw new Error(`No active accounts available for provider: ${providerName}`);
  }
  // ... rest unchanged
```

### 1.5 — Flip ke `active` saat request sukses (`src/proxy/router.ts`, line 172-175)

Di blok `if (result.success)`:

```ts
if (result.success) {
  if (result.tokens) await pool.updateTokens(account.id, result.tokens);
  await pool.markUsed(account.id);
  // NEW: kalau akun ini sebelumnya exhausted, reaktivasi ke active
  if (account.status === "exhausted") {
    await pool.markActiveFromExhausted(account.id);
  }
  return { result, account, provider: providerName, durationMs, compressionStats };
}
```

### 1.6 — Untuk path BYOK (`src/proxy/providers/byok.ts`)

`findAccountForModel` (line 249) saat ini hanya menerima `active` + `error` (line 266, 271). Tambahkan tier exhausted sebagai **last resort**:

```ts
// setelah candidates error (line 273)
if (candidates.length === 0) {
  candidates = entries.filter((entry) =>
    entry.account.enabled && entry.account.status === "exhausted" && supportsModel(entry) && notExcluded(entry)
  );
}
```

Dan di router, `getAccountForModel` untuk BYOK perlu pakai mekanisme `markExhaustedTried` yang sama. Karena BYOK cache berbeda (prefix-based), flag `exhaustedTriedByProvider` pakai key `"byok"` juga.

**Penting untuk BYOK**: `findAccountForModel` sudah pakai `excludeAccountIds` untuk retry, tapi kita perlu pastikan akun exhausted yang sudah dicoba tidak dipilih ulang di retry berikutnya di request yang sama. `excludeAccountIds` di BYOK sudah handle ini via `attemptedByokAccountIds` di router (line 153).

---

## Bagian 2: API Key di UI

### 2.1 — Backend: endpoint reveal generic untuk semua provider (`src/api/accounts.ts`)

Sudah ada `POST /accounts/byok/:id/reveal` (line 354). Tambahkan versi generic:

```ts
// POST /accounts/:id/reveal — reveal api key for any account that has one (BYOK)
// Non-BYOK accounts don't store api keys (they use email/password via auth bot),
// so return a clear message for those.
accountsRouter.post("/:id/reveal", async (c) => {
  const id = Number(c.req.param("id"));
  const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account) return c.json({ error: "Account not found" }, 404);
  if (account.provider === "byok") {
    return c.json({ success: true, id, key: decrypt(account.password), source: "byok" });
  }
  // Non-BYOK: tidak ada api key, hanya email/password (password tidak di-reveal)
  return c.json({ success: false, error: "This account type does not use an API key", source: account.provider });
});
```

Hanya BYOK yang punya api key. Akun codebuddy/kiro dll. didaftarkan via email/password (auth bot), password terenkripsi — demi keamanan **tidak** di-reveal. Jadi kolom API key hanya terisi untuk BYOK; akun lain tampilkan dash/"—".

### 2.2 — `GET /accounts` response (`src/api/accounts.ts`, line 149)

Tambahkan flag boolean `hasApiKey` ke response (tidak bocor key-nya):

```ts
// di mapping (line 152+)
hasApiKey: acc.provider === "byok",
```

### 2.3 — Frontend: `AccountList.tsx` — API key via popover di kolom Email + copy

Bukan kolom terpisah. API key diakses via **popover** pada cell Email (untuk akun BYOK), dengan tombol copy.

- Tambahkan ke interface `Account` (line 41): `hasApiKey?: boolean;`
- Di cell Email (line 619), jika `account.hasApiKey`:
  - Tambahkan icon kecil `Key` (lucide) di samping email
  - Click icon → popover berisi API key (masked default, eye-icon untuk reveal via `POST /accounts/:id/reveal`)
  - Tombol copy (icon `Copy`) menyalin key revealed ke clipboard (`navigator.clipboard.writeText` + toast "Copied")
  - State lokal per-row: `revealedKey`, `isRevealing`
- Akun non-BYOK: cell Email normal tanpa icon

Helper `revealAccountKey(id)` di `dashboard/src/lib/api.ts` → `POST /accounts/:id/reveal`.
Komponen: pakai `Popover` (radix, sudah ter-install) — lebih cocok dari tooltip karena ada interaksi copy.

### 2.4 — Frontend: `ByokAccountList.tsx`

Sudah punya reveal mechanism (line 132-138). Tambahkan tombol copy di samping eye-icon reveal untuk konsistensi.

---

## Bagian 3: Edge cases & safety

1. **PID 30804 (cmd.exe) sedang jalan**: Semua perubahan ini ke kode source. Tidak menyentuh proses yang berjalan. Perubahan aktif setelah user **restart proxy** dengan kode baru.

2. **Quota tracker tetap jalan** untuk statistik (`decrementQuota` di index.ts:370, 510) — tidak dihapus. Hanya **tidak dipakai sebagai mekanisme reaktivasi**. Reaktivasi murni dari hasil request aktual.

3. **Race condition**: `exhaustedTriedByProvider` adalah in-memory Map, diakses async. Karena Node.js single-threaded (event loop), akses Map aman tanpa lock. `invalidate` hapus entry — aman karena `getExhaustedFallbackAccount` baca ulang dari DB.

4. **Grace period 24 jam DIHORMATI** (keputusan user): Akun yang baru saja exhausted (`updatedAt` < 24 jam) di-skip oleh `getExhaustedFallbackAccount` — tidak dipaksa coba. Filter: `updatedAt < now - 24h` → skip. Ini menghindari rate-limit berulang di upstream. Akun exhausted yang sudah > 24 jam boleh dicoba sebagai fallback.

5. **BYOK & non-BYOK path**: Pastikan kedua path (router `getNextAccount` + `getAccountForModel` BYOK) sama-sama punya exhausted fallback.

---

## Urutan implementasi

1. Backend pool: flag in-memory + 3 method baru (`getExhaustedFallbackAccount`, `markExhaustedTried`, `markActiveFromExhausted`) + modifikasi `invalidate`
2. Backend router: modifikasi `routeRequest` (fallback + reaktivasi saat sukses)
3. Backend BYOK provider: tier exhausted di `findAccountForModel`
4. Backend API: endpoint `POST /accounts/:id/reveal` generic + `hasApiKey` di `GET /accounts`
5. Frontend: `revealAccountKey` di api.ts, kolom API Key di `AccountList.tsx`, konsistensi `ByokAccountList.tsx`
6. Test: build backend (bun) + build frontend (npm/bun di dashboard)

## Keputusan final (dari user)

- Grace period 24 jam: **tetap dihormati** — akun < 24 jam exhausted di-skip.
- Tampilan API key: **popover di kolom Email + tombol copy** (bukan kolom terpisah).
- Cakupan API key: **semua tabel akun** (AccountList & ByokAccountList), tapi hanya akun BYOK yang punya key.
