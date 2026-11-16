MVP Lisensi & Transaksi Musik — Kelompok 6 (Minggu 2)

Smart contract `MusicLicensing.sol`: musisi mendaftarkan lagu + aturan split royalti,
pembeli membayar lisensi (POL atau ERC-20 seperti IDRX), royalti dikreditkan ke tiap
kolaborator, lalu ditarik sendiri.

Struktur
- `contracts/MusicLicensing.sol` — kontrak utama (Solidity 0.8.24)
- `contracts/test/Mocks.sol` — MockIDRX, token fee-on-transfer, penerima yang menolak, penyerang reentrancy
- `test/MusicLicensing.test.js` — 17 tes Hardhat
- `model/` — model referensi JS + 9 tes `node:test` (termasuk fuzz 2.000 transaksi)
- `scripts/deploy.js` — deploy lokal / Polygon Amoy (`PAYMENT=native|mock|0x...`)
- `remix/AllContracts.sol` — semua kontrak dalam satu file untuk Remix

Run
```bash
npm install
npx hardhat test          # 17 tes kontrak
npm run test:model        # 9 tes model referensi
cp .env.example .env      # isi DEPLOYER_PRIVATE_KEY
PAYMENT=mock npx hardhat run scripts/deploy.js --network amoy
```

Remix Check
1. Buka https://remix.ethereum.org → buat file baru → upload `remix/AllContracts.sol`.
2. Tab **Solidity Compiler**: versi 0.8.24 → **Compile**.
3. Tab **Deploy & Run** (Remix VM): deploy `MusicLicensing` dengan
   `treasury` = [address Account 2 sebagai fee wallet], 
   `paymentToken` = `0x0000000000000000000000000000000000000000`,
   `minProtocolFee` = `1000000000000000` (0,001 POL).
4. `registerTrack("cid-demo" (ipfsCid), 0x0000000000000000000000000000000000000000000000000000000000000001 (64 bit termsHash), 1000000000000000000 (price), [address Account 1, address Account 3] (payees), [7000, 3000](shareBps))`.
5. Ganti akun (Account 4), isi di page **Deployed Contract**, **Value** = 1 ether, panggil `purchaseLicense(1, 0x0000000000000000000000000000000000000000000000000000000000000001)`.
6. Cek `pendingWithdrawals(address Account1)` = 693000000000000000 (0,693 POL).

## Perubahan minggu 2
- Pembayaran ERC-20 (IDRX) selain POL; deteksi token fee-on-transfer (`TokenAmountMismatch`).
- Harga minimum = 50 × fee minimum → fee efektif ≤ 2% (minggu 1 bisa 20%).
- Jeda darurat pembelian oleh admin; `withdrawRoyalties` tidak pernah dijeda.
- Error baru: `UnexpectedNativePayment`, `TokenAmountMismatch`, `InvalidToken`, `NotAdmin`, `PurchasingPaused`.
- `totalPending` on-chain untuk audit invariant (saldo kontrak ≥ total utang).
