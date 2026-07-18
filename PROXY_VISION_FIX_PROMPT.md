# Prompt: Perbaiki Bug Vision/Image Response di Proxy

> File ini berisi prompt siap pakai untuk memperbaiki bug di project proxy Anda
> (proxy yang meneruskan request Anthropic API → model `cbc-glm-5.2`).
> Copy seluruh isi blok prompt di bawah, lalu tempel ke AI assistant saat mengerjakan
> project proxy.

---

## 📋 Konteks singkat (baca dulu sebelum pakai prompt)

**Gejala:** Saat the assistant (mis. Claude Code) memakai tool `Read` untuk membaca gambar
(PNG/JPG), response yang sampai ke assistant berupa string literal `[object Object]`,
bukan deskripsi/teks gambar.

**Penyebab dugaan:** Proxy meneruskan request image (blok `image` base64 format Anthropic)
ke model dengan benar, TAPI saat mengonversi response model target balik ke format Anthropic
`/v1/messages`, isi `content` tidak di-flatten menjadi string teks. Objek respons
di-serialize pakai `String()` / template literal sehingga jadi `"[object Object]"`.

**Lokasi proxy:** `http://localhost:1930` (via `ANTHROPIC_BASE_URL`), model target
`cbc-glm-5.2`. Proxy adalah bridge format antara Anthropic Messages API ↔ model GLM.

**Catatan:** Sebelum pakai prompt, pastikan varian `cbc-glm-5.2` Anda benar-benar
mendukung multimodal/vision. Kalau bukan varian vision, model bisa return objek kosong
yang juga ikut jadi `[object Object]`.

---

## 🚀 PROMPT UTAMA (copy blok di bawah)

```
Saya punya bug di project proxy saya. Tolong bantu perbaiki dengan teliti.

## Deskripsi bug

Proxy saya adalah bridge antara Anthropic Messages API (/v1/messages) dan model target
"cbc-glm-5.2". Saat client (mis. Claude Code) mengirim request yang berisi blok konten
gambar (image base64) untuk dibaca model, response yang dikembalikan proxy ke client
berisi string literal "[object Object]" alih-alih teks deskripsi gambar dari model.

Artinya: request image diteruskan ke model, TAPI response model gagal dikonversi balik
ke format Anthropic yang benar. Objek response tidak di-flatten menjadi string teks.

## Apa yang harus diperbaiki

Fokus pada **konverter response** di proxy — bagian yang menerjemahkan response model
target (cbc-glm-5.2, kemungkinan format OpenAI/GLM-style) kembali ke format Anthropic
Messages API.

Output Anthropic yang BENAR untuk content block teks:
  {
    "type": "text",
    "text": "string teks murni di sini"   ← HARUS string, bukan objek
  }

Bug saat ini kemungkinan besar disebabkan oleh salah satu:
1. response content di-serialize pakai String()/template literal pada objek:
     text: `${responseObject}`          → "[object Object]"   ❌
   bukan:
     text: responseObject.content        → "deskripsi gambar"  ✅
2. model mengembalikan content sebagai ARRAY berisi objek (bukan string), dan adaptor
   proxy tidak join/ekstrak elemennya dengan benar sebelum dibungkus jadi text block.
3. struktur response model target berbeda asumsi (mis. field beda nama, nested lebih
   dalam) sehingga ekstraksi teks meleset dan menangkap objek utuh.

## Langkah pengerjaan

1. Cari di kode proxy: fungsi/handler yang menerima response dari model target
   (cbc-glm-5.2) dan mengubahnya jadi response Anthropic /v1/messages. Cari kata kunci:
   "content", "text", "message", "choices", "transform", "convert", "map response".

2. Identifikasi struktur response aktual dari model target. Kalau perlu, tambahkan
   logging sementara (console.log/JSON.stringify dengan aman) untuk mencetak struktur
   response mentah dari model saat ada request image. Lihat persis field mana yang
   berisi teks deskripsi gambar.

3. Pastikan setiap content block yang dikembalikan ke client Anthropic diformat:
     { "type": "text", "text": "<STRING>" }
   di mana `text` WAJIB string primitif. Lakukan ekstraksi/flatten yang benar:
   - kalau model return string langsung → pakai langsung
   - kalau model return array of content parts → map tiap part, ambil .text-nya,
     join dengan newline kalau lebih dari satu
   - kalau nested lebih dalam → telusuri sampai dapat string teksnya
   - JANGAN pernah menempel objek ke template literal/toString tanpa ekstraksi field.

4. Tangani edge case:
   - content kosong/null → jangan jadi "[object Object]", kirim string kosong "" atau
     lewati block.
   - model return error → terjemahkan jadi error response Anthropic yang jelas, bukan
     string "[object Object]".
   - multi-part content (text + tool_use dll.) → pertahankan struktur array, tiap block
     tetap punya type & field yang benar.

5. Hapus logging sementara setelah selesai.

## Cara verifikasi

Buat/berikan test yang mengirim request image ke proxy lalu cek response:
- Response content HARUS berisi { "type": "text", "text": "<string non-kosong>" }.
- Tidak boleh ada "[object Object]" di mana pun di response.
- Kalau model tidak mendukung vision (return kosong/error), response harus menunjukkan
  error yang jelas, bukan "[object Object]".

Contoh test pakai curl (sesuaikan field bila perlu):
  curl -X POST http://localhost:1930/v1/messages \
    -H "Content-Type: application/json" \
    -d '{
      "model": "cbc-glm-5.2",
      "max_tokens": 1000,
      "messages": [{
        "role": "user",
        "content": [
          {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<BASE64>"}},
          {"type": "text", "text": "Deskripsikan gambar ini"}
        ]
      }]
    }'

Response yang benar → content[0].text berisi deskripsi teks dari model.
Response bug → content[0].text berisi "[object Object]".

## Aturan tambahan

- Ubah bagian yang perlu diubah saja (targeted edit). Jangan rewrite seluruh file proxy
  kecuali memang wajib.
- Jelaskan root cause spesifik yang kamu temukan (baris/file mana yang bermasalah)
  sebelum melakukan fix.
- Kalau ternyata model cbc-glm-5.2 bukan varian vision (tidak bisa proses gambar),
  beri tahu saya — mungkin perlu ganti varian model atau blok request image di-reject
  dengan error yang jelas di sisi proxy.
```

---

## 🧪 Prompt tambahan: cek varian model (opsional, pakai kalau ragu model support vision)

```
Sebelum fix konverter response, tolong cek apakah model target "cbc-glm-5.2" di proxy
saya benar-benar mendukung multimodal/vision input.

Lakukan:
1. Cari dokumentasi/konfigurasi model di project proxy — apakah cbc-glm-5.2 adalah
   varian vision-capable?
2. Tambahkan logging sementara untuk mencetak response MENTAH dari model saat request
   berisi blok image (sebelum konversi ke format Anthropic).
3. Laporkan: apakah model return deskripsi gambar (berarti vision support, bug ada di
   konverter), atau return kosong/error/objek aneh (berarti model tidak support vision
   atau request image tidak sampai terformat benar ke model).

Berdasarkan temuan, kasih rekomendasi:
- Kalau model support vision & return teks → bug di konverter response (lanjut fix).
- Kalau model TIDAK support vision → tambahkan validasi di proxy: tolak blok image
  dengan error Anthropic yang jelas, jangan diteruskan ke model.
```

---

## 📝 Catatan untuk Anda (pemilik project)

- Jalankan prompt di folder project **proxy** Anda (bukan simdok-fe/simdok-be).
- Sebelum fix, backup dulu file konverter response yang akan diubah.
- Setelah fix, test ulang dari the assistant (Claude Code) dengan Read gambar untuk
  pastikan `[object Object]` hilang dan deskripsi gambar muncul.
- Kalau model `cbc-glm-5.2` ternyata bukan vision-capable, opsi alternatif:
  ganti ke model varian vision, atau tolak image request di proxy dengan error jelas.
