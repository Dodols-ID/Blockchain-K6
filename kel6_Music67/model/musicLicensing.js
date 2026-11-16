// Model referensi (JavaScript, BigInt) yang meniru aturan MusicLicensing.sol baris per baris.
// Tujuan: menguji aturan bisnis tanpa compiler Solidity. Bukan pengganti tes Hardhat.
const BPS = 10000n, FEE_BPS = 100n, MAX_FEE_BPS = 200n, MAX_COLLAB = 10;

class Revert extends Error { constructor(name, ...args) { super(name); this.name = name; this.args = args; } }

class MusicLicensing {
  constructor(treasury, minProtocolFee, admin = "admin") {
    if (!treasury) throw new Revert("ZeroAddress");
    if (BigInt(minProtocolFee) === 0n) throw new Revert("PriceTooLow");
    this.admin = admin; this.paused = false; this.rejecting = new Set(); // dompet yang menolak transfer
    this.treasury = treasury; this.minProtocolFee = BigInt(minProtocolFee);
    this.minLicensePrice = (this.minProtocolFee * BPS) / MAX_FEE_BPS;
    this.tracks = new Map(); this.licenses = new Map();
    this.cids = new Set(); this.pending = new Map(); this.balance = 0n;
    this.trackCount = 0; this.licenseCount = 0; this.events = [];
  }
  _credit(a, v) { this.pending.set(a, (this.pending.get(a) || 0n) + v); }
  _track(id) { const t = this.tracks.get(id); if (!t) throw new Revert("TrackNotFound", id); return t; }
  protocolFeeFor(price) { const p = (BigInt(price) * FEE_BPS) / BPS; return p > this.minProtocolFee ? p : this.minProtocolFee; }

  registerTrack(sender, cid, termsHash, price, payees, shares) {
    price = BigInt(price);
    if (!cid) throw new Revert("EmptyCid");
    if (this.cids.has(cid)) throw new Revert("DuplicateCid");
    const n = payees.length;
    if (n === 0 || n !== shares.length || n > MAX_COLLAB) throw new Revert("InvalidCollaborators");
    let total = 0n;
    payees.forEach((p, i) => {
      if (!p) throw new Revert("ZeroAddress");
      if (shares[i] === 0) throw new Revert("InvalidCollaborators");
      if (payees.slice(0, i).includes(p)) throw new Revert("InvalidCollaborators");
      total += BigInt(shares[i]);
    });
    if (total !== BPS) throw new Revert("InvalidShareTotal", total);
    if (price < this.minLicensePrice) throw new Revert("PriceTooLow");
    const id = ++this.trackCount; this.cids.add(cid);
    this.tracks.set(id, { owner: sender, cid, termsHash, price, active: true, payees: [...payees], shares: shares.map(BigInt) });
    this.events.push(["TrackRegistered", id]);
    return id;
  }

  purchaseLicense(sender, trackId, acceptedTerms, value) {
    value = BigInt(value);
    if (this.paused) throw new Revert("PurchasingPaused");
    const t = this._track(trackId);
    if (!t.active) throw new Revert("TrackNotActive", trackId);
    if (acceptedTerms !== t.termsHash) throw new Revert("TermsMismatch");
    if (value !== t.price) throw new Revert("InsufficientPayment", value, t.price);
    this.balance += value;
    const id = ++this.licenseCount;
    this.licenses.set(id, { trackId, licensee: sender, pricePaid: value, termsHash: t.termsHash });
    const fee = this.protocolFeeFor(value); this._credit(this.treasury, fee);
    const net = value - fee; let dist = 0n;
    t.payees.forEach((p, i) => {
      const amt = i === t.payees.length - 1 ? net - dist : (net * t.shares[i]) / BPS;
      dist += amt; this._credit(p, amt);
    });
    this.events.push(["LicensePurchased", id, trackId, sender]);
    return id;
  }

  withdrawRoyalties(sender) {
    const amt = this.pending.get(sender) || 0n;
    if (amt === 0n) throw new Revert("NothingToWithdraw");
    if (this.rejecting.has(sender)) throw new Revert("TransferFailed"); // seluruh tx dibatalkan, saldo utuh
    this.pending.set(sender, 0n); this.balance -= amt; return amt;
  }
  setTrackActive(sender, id, active) { const t = this._track(id); if (t.owner !== sender) throw new Revert("NotTrackOwner"); t.active = active; }
  setTrackPrice(sender, id, p) { const t = this._track(id); if (t.owner !== sender) throw new Revert("NotTrackOwner"); if (BigInt(p) < this.minLicensePrice) throw new Revert("PriceTooLow"); t.price = BigInt(p); }
  setPurchasesPaused(sender, v) { if (sender !== this.admin) throw new Revert("NotAdmin"); this.paused = v; }
  verifyLicense(id, who) { const l = this.licenses.get(id); return { valid: !!l && l.licensee === who, trackId: l ? l.trackId : 0 }; }
  totalPending() { let s = 0n; for (const v of this.pending.values()) s += v; return s; }
}

module.exports = { MusicLicensing, Revert, BPS };
