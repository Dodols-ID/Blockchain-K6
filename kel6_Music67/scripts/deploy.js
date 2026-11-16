// Deploy MusicLicensing.
//   PAYMENT=native  → bayar dengan POL (default)
//   PAYMENT=mock    → deploy MockIDRX (2 desimal) dulu, bayar dengan token itu (untuk Amoy)
//   PAYMENT=0x...   → pakai alamat ERC-20 yang sudah ada (mis. IDRX di Polygon mainnet)
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const mode = process.env.PAYMENT || "native";

  let token = ethers.ZeroAddress;
  let minFee = ethers.parseEther(process.env.MIN_FEE_POL || "0.001");

  if (mode === "mock") {
    const m = await (await ethers.getContractFactory("MockIDRX")).deploy(2);
    await m.waitForDeployment();
    token = await m.getAddress();
    minFee = 1000n * 100n; // Rp1.000 dengan 2 desimal
    console.log(`MockIDRX @ ${token}`);
  } else if (mode.startsWith("0x")) {
    token = mode;
    const dec = await (await ethers.getContractAt(["function decimals() view returns (uint8)"], token)).decimals();
    minFee = 1000n * 10n ** BigInt(dec); // Rp1.000 sesuai desimal token
    console.log(`Token ${token}, desimal ${dec}`);
  }

  const c = await (await ethers.getContractFactory("MusicLicensing")).deploy(treasury, token, minFee);
  await c.waitForDeployment();
  console.log(`MusicLicensing @ ${await c.getAddress()} (network: ${network.name})`);
  console.log(`minProtocolFee=${minFee} minLicensePrice=${await c.minLicensePrice()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
