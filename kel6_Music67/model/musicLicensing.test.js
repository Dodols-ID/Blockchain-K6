// node --test model/
const test = require("node:test");
const assert = require("node:assert/strict");
const { MusicLicensing } = require("./musicLicensing");

const E = 10n ** 18n;              // 1 POL dalam wei
const MIN = E / 1000n;             // 0.001 POL
const TERMS = "0xterms-v1", CID = "bafy-demo";
const fresh = () => new MusicLicensing("treasury", MIN);
const rejects = (fn, name) => assert.throws(fn, (e) => e.name === name);

test("registerTrack menyimpan track & mengunci split", () => {
  const c = fresh();
  const id = c.registerTrack("musisi", CID, TERMS, E, ["musisi", "komposer"], [7000, 3000]);
  assert.equal(id, 1);
  assert.deepEqual(c.tracks.get(1).payees, ["musisi", "komposer"]);
});

test("registerTrack: validasi input", () => {
  const c = fresh();
  rejects(() => c.registerTrack("a", CID, TERMS, E, ["a", "b"], [7000, 2000]), "InvalidShareTotal");
  rejects(() => c.registerTrack("a", CID, TERMS, E, ["a", "a"], [5000, 5000]), "InvalidCollaborators");
  rejects(() => c.registerTrack("a", CID, TERMS, E, ["a"], [5000, 5000]), "InvalidCollaborators");
  rejects(() => c.registerTrack("a", CID, TERMS, E, ["a", "b"], [10000, 0]), "InvalidCollaborators");
  rejects(() => c.registerTrack("a", CID, TERMS, E, Array.from({ length: 11 }, (_, i) => "p" + i), Array(11).fill(909)), "InvalidCollaborators");
  rejects(() => c.registerTrack("a", "", TERMS, E, ["a"], [10000]), "EmptyCid");
  rejects(() => c.registerTrack("a", CID, TERMS, MIN * 50n - 1n, ["a"], [10000]), "PriceTooLow");
  c.registerTrack("a", CID, TERMS, E, ["a"], [10000]);
  rejects(() => c.registerTrack("b", CID, TERMS, E, ["b"], [10000]), "DuplicateCid");
});

test("purchaseLicense: fee 1% lalu split 70/30", () => {
  const c = fresh();
  c.registerTrack("musisi", CID, TERMS, E, ["musisi", "komposer"], [7000, 3000]);
  const lid = c.purchaseLicense("pembeli", 1, TERMS, E);
  const fee = E / 100n, net = E - fee;
  assert.equal(c.pending.get("treasury"), fee);
  assert.equal(c.pending.get("musisi"), (net * 7000n) / 10000n);
  assert.equal(c.pending.get("komposer"), net - (net * 7000n) / 10000n);
  assert.deepEqual(c.verifyLicense(lid, "pembeli"), { valid: true, trackId: 1 });
  assert.equal(c.verifyLicense(lid, "orang-lain").valid, false);
});

test("harga minimum = 50 × fee minimum; fee efektif tidak pernah > 2%", () => {
  const c = fresh();
  assert.equal(c.minLicensePrice, MIN * 50n);
  c.registerTrack("m", CID, TERMS, MIN * 50n, ["m"], [10000]);
  c.purchaseLicense("b", 1, TERMS, MIN * 50n);
  assert.equal(c.pending.get("treasury"), MIN);                 // tepat 2%
  for (const p of [MIN * 50n, MIN * 77n, MIN * 100n, E, 123456789n * MIN]) {
    assert.ok(c.protocolFeeFor(p) * 10000n <= p * 200n, `fee > 2% pada harga ${p}`);
  }
});

test("Rupiah (IDRX, 2 desimal): Rp150.000 split 60/40", () => {
  const RP = (n) => BigInt(n) * 100n;
  const c = new MusicLicensing("treasury", RP(1000));
  assert.equal(c.minLicensePrice, RP(50_000));
  c.registerTrack("m", CID, TERMS, RP(150_000), ["m", "k"], [6000, 4000]);
  c.purchaseLicense("b", 1, TERMS, RP(150_000));
  assert.equal(c.pending.get("treasury"), RP(1_500));
  assert.equal(c.pending.get("m"), RP(89_100));
  assert.equal(c.pending.get("k"), RP(59_400));
});

test("jeda darurat & penerima yang menolak transfer", () => {
  const c = fresh();
  c.registerTrack("m", CID, TERMS, E, ["m", "jahat"], [5000, 5000]);
  c.rejecting.add("jahat");
  c.purchaseLicense("b", 1, TERMS, E);                           // pembelian tetap sukses
  rejects(() => c.withdrawRoyalties("jahat"), "TransferFailed");
  assert.ok(c.pending.get("jahat") > 0n);                        // saldo utuh
  c.withdrawRoyalties("m");                                      // kolaborator lain aman
  rejects(() => c.setPurchasesPaused("orang", true), "NotAdmin");
  c.setPurchasesPaused("admin", true);
  rejects(() => c.purchaseLicense("b", 1, TERMS, E), "PurchasingPaused");
});

test("purchaseLicense: revert yang diharapkan", () => {
  const c = fresh();
  c.registerTrack("m", CID, TERMS, E, ["m"], [10000]);
  rejects(() => c.purchaseLicense("b", 1, TERMS, E - 1n), "InsufficientPayment");
  rejects(() => c.purchaseLicense("b", 1, TERMS, E + 1n), "InsufficientPayment");
  rejects(() => c.purchaseLicense("b", 1, "0xlain", E), "TermsMismatch");
  rejects(() => c.purchaseLicense("b", 9, TERMS, E), "TrackNotFound");
  rejects(() => c.setTrackActive("bukan-pemilik", 1, false), "NotTrackOwner");
  c.setTrackActive("m", 1, false);
  rejects(() => c.purchaseLicense("b", 1, TERMS, E), "TrackNotActive");
});

test("withdrawRoyalties mengosongkan saldo", () => {
  const c = fresh();
  c.registerTrack("m", CID, TERMS, E, ["m"], [10000]);
  c.purchaseLicense("b", 1, TERMS, E);
  const due = c.pending.get("m");
  assert.equal(c.withdrawRoyalties("m"), due);
  rejects(() => c.withdrawRoyalties("m"), "NothingToWithdraw");
});

test("fuzz: dana selalu kekal & tidak ada wei hilang (2.000 transaksi acak)", () => {
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const c = fresh();
  for (let k = 0; k < 50; k++) {
    const n = 1 + rnd(10);
    const payees = Array.from({ length: n }, (_, i) => `t${k}p${i}`);
    // bagi 10.000 bps secara acak, tiap porsi ≥ 1
    const cuts = new Set(); while (cuts.size < n - 1) cuts.add(1 + rnd(9999));
    const pts = [0, ...[...cuts].sort((a, b) => a - b), 10000];
    const shares = pts.slice(1).map((v, i) => v - pts[i]);
    const price = MIN * 50n + BigInt(rnd(1e9)) * 10n ** 9n;
    c.registerTrack(payees[0], `cid-${k}`, TERMS, price, payees, shares);
  }
  let paid = 0n, withdrawn = 0n;
  for (let i = 0; i < 2000; i++) {
    const id = 1 + rnd(50), t = c.tracks.get(id);
    c.purchaseLicense(`buyer${rnd(30)}`, id, TERMS, t.price); paid += t.price;
    if (rnd(5) === 0) { const p = t.payees[rnd(t.payees.length)]; if ((c.pending.get(p) || 0n) > 0n) withdrawn += c.withdrawRoyalties(p); }
    assert.equal(c.totalPending() + withdrawn, paid);   // invariant kekekalan
    assert.equal(c.balance, c.totalPending());          // saldo kontrak = total utang
  }
  assert.equal(c.licenseCount, 2000);
});
