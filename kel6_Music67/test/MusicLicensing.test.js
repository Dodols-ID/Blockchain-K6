// Tes Hardhat (ethers v6 + chai). Jalankan: npx hardhat test
const { expect } = require("chai");
const { ethers } = require("hardhat");

const MIN_FEE = ethers.parseEther("0.001");          // padanan "Rp1.000" di testnet
const MIN_PRICE = MIN_FEE * 50n;                       // fee efektif maks 2%
const PRICE = ethers.parseEther("1");
const TERMS = ethers.keccak256(ethers.toUtf8Bytes("LISENSI-SINKRONISASI-v1"));
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

async function deployNative() {
  const [admin, owner, collab, buyer, treasury, other] = await ethers.getSigners();
  const c = await (await ethers.getContractFactory("MusicLicensing")).deploy(treasury.address, ethers.ZeroAddress, MIN_FEE);
  return { c, admin, owner, collab, buyer, treasury, other };
}

describe("MusicLicensing — minggu 2", function () {
  // ===================================================================
  describe("registerTrack", () => {
    let c, owner, collab, other;
    beforeEach(async () => ({ c, owner, collab, other } = await deployNative()));

    it("menyimpan track dan emit event", async () => {
      await expect(c.connect(owner).registerTrack(CID, TERMS, PRICE, [owner.address, collab.address], [7000, 3000]))
        .to.emit(c, "TrackRegistered").withArgs(1n, owner.address, CID, PRICE, TERMS);
      const t = await c.getTrack(1);
      expect([...t.payees]).to.deep.equal([owner.address, collab.address]);
    });
    it("InvalidShareTotal bila total ≠ 10.000 bps", async () => {
      await expect(c.registerTrack(CID, TERMS, PRICE, [owner.address, collab.address], [7000, 2000]))
        .to.be.revertedWithCustomError(c, "InvalidShareTotal").withArgs(9000n);
    });
    it("DuplicateCid, InvalidCollaborators, ZeroAddress, EmptyCid", async () => {
      await expect(c.registerTrack("", TERMS, PRICE, [owner.address], [10000])).to.be.revertedWithCustomError(c, "EmptyCid");
      await expect(c.registerTrack(CID, TERMS, PRICE, [owner.address, owner.address], [5000, 5000])).to.be.revertedWithCustomError(c, "InvalidCollaborators");
      await expect(c.registerTrack(CID, TERMS, PRICE, [owner.address], [5000, 5000])).to.be.revertedWithCustomError(c, "InvalidCollaborators");
      await expect(c.registerTrack(CID, TERMS, PRICE, [ethers.ZeroAddress], [10000])).to.be.revertedWithCustomError(c, "ZeroAddress");
      const eleven = Array.from({ length: 11 }, () => ethers.Wallet.createRandom().address);
      await expect(c.registerTrack(CID, TERMS, PRICE, eleven, Array(11).fill(909))).to.be.revertedWithCustomError(c, "InvalidCollaborators");
      await c.connect(owner).registerTrack(CID, TERMS, PRICE, [owner.address], [10000]);
      await expect(c.connect(other).registerTrack(CID, TERMS, PRICE, [other.address], [10000])).to.be.revertedWithCustomError(c, "DuplicateCid");
    });
    it("PriceTooLow di bawah harga minimum (fee efektif > 2%)", async () => {
      expect(await c.minLicensePrice()).to.equal(MIN_PRICE);
      await expect(c.registerTrack(CID, TERMS, MIN_PRICE - 1n, [owner.address], [10000]))
        .to.be.revertedWithCustomError(c, "PriceTooLow").withArgs(MIN_PRICE - 1n, MIN_PRICE);
      await c.registerTrack(CID, TERMS, MIN_PRICE, [owner.address], [10000]); // tepat di batas: boleh
    });
  });

  // ===================================================================
  describe("purchaseLicense (POL)", () => {
    let c, admin, owner, collab, buyer, treasury, other;
    beforeEach(async () => {
      ({ c, admin, owner, collab, buyer, treasury, other } = await deployNative());
      await c.connect(owner).registerTrack(CID, TERMS, PRICE, [owner.address, collab.address], [7000, 3000]);
    });

    it("fee 1% lalu split 70/30, total kekal", async () => {
      await expect(c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE }))
        .to.emit(c, "LicensePurchased").withArgs(1n, 1n, buyer.address, PRICE, TERMS);
      const fee = PRICE / 100n, net = PRICE - fee, a = (net * 7000n) / 10000n;
      expect(await c.pendingWithdrawals(treasury.address)).to.equal(fee);
      expect(await c.pendingWithdrawals(owner.address)).to.equal(a);
      expect(await c.pendingWithdrawals(collab.address)).to.equal(net - a);
      expect(await c.totalPending()).to.equal(PRICE);
      expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(PRICE);
    });
    it("fee efektif tepat 2% pada harga minimum", async () => {
      await c.connect(owner).registerTrack("cid-min", TERMS, MIN_PRICE, [owner.address], [10000]);
      await c.connect(buyer).purchaseLicense(2, TERMS, { value: MIN_PRICE });
      expect(await c.pendingWithdrawals(treasury.address)).to.equal(MIN_FEE);
      expect(MIN_FEE * 10000n / MIN_PRICE).to.equal(200n);
    });
    it("InsufficientPayment (kurang/lebih), TermsMismatch, TrackNotFound, TrackNotActive", async () => {
      await expect(c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE - 1n })).to.be.revertedWithCustomError(c, "InsufficientPayment");
      await expect(c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE + 1n })).to.be.revertedWithCustomError(c, "InsufficientPayment");
      await expect(c.connect(buyer).purchaseLicense(1, ethers.ZeroHash, { value: PRICE })).to.be.revertedWithCustomError(c, "TermsMismatch");
      await expect(c.connect(buyer).purchaseLicense(99, TERMS, { value: PRICE })).to.be.revertedWithCustomError(c, "TrackNotFound");
      await c.connect(owner).setTrackActive(1, false);
      await expect(c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE })).to.be.revertedWithCustomError(c, "TrackNotActive");
    });
    it("NotTrackOwner untuk ubah status/harga", async () => {
      await expect(c.connect(other).setTrackActive(1, false)).to.be.revertedWithCustomError(c, "NotTrackOwner");
      await expect(c.connect(other).setTrackPrice(1, PRICE * 2n)).to.be.revertedWithCustomError(c, "NotTrackOwner");
      await expect(c.connect(owner).setTrackPrice(1, MIN_PRICE - 1n)).to.be.revertedWithCustomError(c, "PriceTooLow");
    });
    it("jeda darurat: pembelian berhenti, withdraw tetap jalan", async () => {
      await c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE });
      await expect(c.connect(other).setPurchasesPaused(true)).to.be.revertedWithCustomError(c, "NotAdmin");
      await c.connect(admin).setPurchasesPaused(true);
      await expect(c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE })).to.be.revertedWithCustomError(c, "PurchasingPaused");
      await expect(c.connect(collab).withdrawRoyalties()).to.not.be.reverted;
    });
  });

  // ===================================================================
  describe("withdrawRoyalties & serangan", () => {
    it("menarik saldo, lalu NothingToWithdraw", async () => {
      const { c, owner, collab, buyer } = await deployNative();
      await c.connect(owner).registerTrack(CID, TERMS, PRICE, [owner.address, collab.address], [7000, 3000]);
      await c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE });
      const due = await c.pendingWithdrawals(collab.address);
      await expect(c.connect(collab).withdrawRoyalties()).to.changeEtherBalance(collab, due);
      await expect(c.connect(collab).withdrawRoyalties()).to.be.revertedWithCustomError(c, "NothingToWithdraw");
    });
    it("kolaborator yang menolak POL tidak memblokir pembeli & kolaborator lain", async () => {
      const { c, owner, buyer } = await deployNative();
      const bad = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      await c.connect(owner).registerTrack(CID, TERMS, PRICE, [owner.address, await bad.getAddress()], [5000, 5000]);
      await c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE });           // tetap sukses
      await expect(c.connect(owner).withdrawRoyalties()).to.not.be.reverted;          // owner aman
      await expect(bad.withdrawFrom(await c.getAddress())).to.be.revertedWithCustomError(c, "TransferFailed");
      expect(await c.pendingWithdrawals(await bad.getAddress())).to.be.gt(0n);        // saldo tidak hilang
    });
    it("reentrancy ditolak dan saldo utuh", async () => {
      const { c, owner, buyer } = await deployNative();
      const atk = await (await ethers.getContractFactory("ReentrantPayee")).deploy(await c.getAddress());
      await c.connect(owner).registerTrack(CID, TERMS, PRICE, [await atk.getAddress()], [10000]);
      await c.connect(buyer).purchaseLicense(1, TERMS, { value: PRICE });
      const before = await c.pendingWithdrawals(await atk.getAddress());
      await expect(atk.attack()).to.be.revertedWithCustomError(c, "TransferFailed");
      expect(await c.pendingWithdrawals(await atk.getAddress())).to.equal(before);
      expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(PRICE);
    });
  });

  // ===================================================================
  describe("pembayaran ERC-20 (Mock IDRX)", () => {
    // IDRX: 1 token = Rp1. Pakai 2 desimal agar angka mudah dibaca: Rp1.000 = 100_000 unit.
    const RP = (n) => BigInt(n) * 100n;
    let c, tok, owner, collab, buyer, treasury;
    beforeEach(async () => {
      [, owner, collab, buyer, treasury] = await ethers.getSigners();
      tok = await (await ethers.getContractFactory("MockIDRX")).deploy(2);
      c = await (await ethers.getContractFactory("MusicLicensing")).deploy(treasury.address, await tok.getAddress(), RP(1000));
      await tok.mint(buyer.address, RP(10_000_000));
      await tok.connect(buyer).approve(await c.getAddress(), ethers.MaxUint256);
    });

    it("harga minimum Rp50.000; lisensi Rp150.000 → fee Rp1.500", async () => {
      expect(await c.minLicensePrice()).to.equal(RP(50_000));
      await c.connect(owner).registerTrack(CID, TERMS, RP(150_000), [owner.address, collab.address], [6000, 4000]);
      await c.connect(buyer).purchaseLicense(1, TERMS);
      expect(await c.pendingWithdrawals(treasury.address)).to.equal(RP(1_500));
      expect(await c.pendingWithdrawals(owner.address)).to.equal(RP(89_100));
      expect(await c.pendingWithdrawals(collab.address)).to.equal(RP(59_400));
      await expect(c.connect(collab).withdrawRoyalties()).to.changeTokenBalance(tok, collab, RP(59_400));
    });
    it("UnexpectedNativePayment bila kirim POL ke kontrak mode token", async () => {
      await c.connect(owner).registerTrack(CID, TERMS, RP(150_000), [owner.address], [10000]);
      await expect(c.connect(buyer).purchaseLicense(1, TERMS, { value: 1n })).to.be.revertedWithCustomError(c, "UnexpectedNativePayment");
    });
    it("TransferFailed bila allowance/saldo kurang", async () => {
      await c.connect(owner).registerTrack(CID, TERMS, RP(150_000), [owner.address], [10000]);
      await tok.connect(buyer).approve(await c.getAddress(), 0);
      await expect(c.connect(buyer).purchaseLicense(1, TERMS)).to.be.revertedWithCustomError(c, "TransferFailed");
    });
    it("TokenAmountMismatch: token fee-on-transfer ditolak", async () => {
      const fot = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy();
      const c2 = await (await ethers.getContractFactory("MusicLicensing")).deploy(treasury.address, await fot.getAddress(), 10n ** 15n);
      await fot.mint(buyer.address, PRICE);
      await fot.connect(buyer).approve(await c2.getAddress(), PRICE);
      await c2.connect(owner).registerTrack(CID, TERMS, PRICE, [owner.address], [10000]);
      await expect(c2.connect(buyer).purchaseLicense(1, TERMS)).to.be.revertedWithCustomError(c2, "TokenAmountMismatch");
    });
    it("InvalidToken bila alamat token bukan kontrak", async () => {
      const F = await ethers.getContractFactory("MusicLicensing");
      await expect(F.deploy(treasury.address, owner.address, 1n)).to.be.revertedWithCustomError(F, "InvalidToken");
    });
  });
});
